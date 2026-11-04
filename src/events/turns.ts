// Turns. pi's own "turn" is one model request; an AHP turn is everything one
// prompt sets off, up to agent_settled. A prompt can be refused and rewritten at
// `input`, and added to at before_agent_start; agent_before_settle is where a
// backend asks for another pass.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Permission, state } from "agenthooksprotocol/client";
import { MAX_CONTINUATIONS } from "../capabilities.js";
import { type Adapter, EXTENSION, type Turn } from "../adapter.js";
import { applyParts, customKey, partsOf, type Block, type Message, type Part } from "../content.js";
import { denial, flow, injections } from "../effects.js";

function newTurn(): Turn {
  return { id: crypto.randomUUID(), continuationCount: 0, requests: 0, failures: 0, began: false, pending: [], context: [] };
}

function prompt(id: string, text: string, images: readonly Block[] | undefined): Message {
  return { id, role: "user", synthesized: true, parts: partsOf(id, [{ type: "text", text }, ...(images ?? [])]) };
}

/** A prompt's effective text and images, once a backend has seen it. */
function rewritten(id: string, text: string, images: readonly Block[] | undefined, effective: readonly Part[] | undefined) {
  const native: readonly Block[] = [{ type: "text", text }, ...(images ?? [])];
  const next = applyParts(id, native, effective);
  if (next === native) return undefined;
  return {
    text: next.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n"),
    images: next.filter((block) => block.type === "image"),
  };
}

export function turns(adapter: Adapter): void {
  const { pi } = adapter;

  pi.on("input", async (event, ctx) => {
    adapter.ctx = ctx;
    await adapter.flush();
    // A prompt something handled after we saw it never began: it is over.
    if (adapter.turn && !adapter.turn.began && ctx.isIdle()) await endTurn(adapter, "cancelled");
    const images = event.images as readonly Block[] | undefined;

    // Into a running turn: a steering or follow-up message, not a turn of its own.
    if (event.streamingBehavior || adapter.turn) {
      const hooks = adapter.client("user.message.inbound");
      if (!hooks) return;
      const id = `${adapter.turn?.id ?? adapter.sessionId}:inbound:${crypto.randomUUID()}`;
      const result = await hooks.userMessageInbound({
        ...adapter.scope(),
        message: { channel: "prompt", sender: "user", messages: [prompt(id, event.text, images) as never] },
      }, { initialState: state.initial(Permission.None) });
      adapter.report(result);
      const refused = denial(result);
      if (refused !== undefined) {
        adapter.notify(refused, "error");
        return { action: "handled" };
      }
      const effective = (result.event as { message?: { messages?: { parts?: Part[] }[] } }).message?.messages?.[0];
      const next = rewritten(id, event.text, images, effective?.parts);
      return next ? { action: "transform", text: next.text, images: next.images as never } : undefined;
    }

    const turn = newTurn();
    const hooks = adapter.client("turn.start");
    if (!hooks) {
      adapter.turn = turn;
      return;
    }
    const id = `${turn.id}:prompt`;
    const result = await hooks.turnStart({
      turn: adapter.turnObject(turn),
      session: adapter.sessionObject(),
      trigger: event.source === "extension" ? "external" : "user",
      items: [prompt(id, event.text, images) as never],
    }, { initialState: state.initial(Permission.None) });
    adapter.report(result);
    const refused = denial(result);
    if (refused !== undefined) {
      adapter.notify(refused, "error");
      return { action: "handled" };
    }
    adapter.turn = turn;
    turn.pending.push(...injections(result));
    const effective = (result.event as { items?: { parts?: Part[] }[] }).items?.[0];
    const next = rewritten(id, event.text, images, effective?.parts);
    return next ? { action: "transform", text: next.text, images: next.images as never } : undefined;
  });

  /** A run with no prompt behind it: an extension's own message started it. */
  async function externalTurn(ctx: ExtensionContext, content: string | readonly Block[] | undefined, refusedKey?: string): Promise<Turn> {
    const turn = newTurn();
    adapter.turn = turn;
    turn.began = true;
    const hooks = adapter.client("turn.start");
    if (!hooks) return turn;
    const id = `${turn.id}:prompt`;
    const result = await hooks.turnStart({
      turn: adapter.turnObject(turn),
      session: adapter.sessionObject(),
      trigger: "external",
      items: content === undefined ? [] : [{ id, role: "user", synthesized: true, parts: partsOf(id, content) } as never],
      ...(content === undefined ? { gaps: [{ path: "items", reason: "pi before 1.2 does not say what an extension's message started a run with" }] } : {}),
    }, { initialState: state.initial(Permission.None) });
    adapter.report(result);
    const refused = denial(result);
    if (refused !== undefined) {
      // Too late to refuse by handling it: the run stops before its first request.
      turn.cancelled = true;
      if (refusedKey !== undefined) adapter.refusedMessages.add(refusedKey);
      adapter.notify(refused, "error");
      ctx.abort();
    } else {
      turn.pending.push(...injections(result));
    }
    return turn;
  }

  pi.on("before_agent_start", async (event, ctx) => {
    adapter.ctx = ctx;
    await adapter.flush();
    const turn = adapter.turn ?? (event.messageType === "custom"
      ? await externalTurn(ctx, event.message.content as string | readonly Block[], customKey(event.message.customType, event.message.content))
      : await externalTurn(ctx, event.prompt));
    turn.began = true;
    if (turn.cancelled || !turn.pending.length) return;
    return { message: adapter.customMessage(turn.pending.splice(0).join("\n\n")) };
  });

  // Before 1.2, before_agent_start is not raised for a run an extension's message starts.
  pi.on("agent_start", async (_event, ctx) => {
    adapter.ctx = ctx;
    if (adapter.turn) return;
    await adapter.flush();
    const turn = await externalTurn(ctx, undefined);
    // No before_agent_start is coming to carry this.
    if (!turn.cancelled) turn.context.push(...turn.pending.splice(0));
  });

  pi.on("message_update", (event, ctx) => {
    adapter.ctx = ctx;
    const delta = event.assistantMessageEvent;
    if (delta.type !== "text_delta" || !adapter.turn) return;
    const hooks = adapter.client("turn.progress");
    if (!hooks) return;
    const turn = adapter.turn;
    const item = `${turn.id}:${turn.requests}:response`;
    const piece = `${item}:${crypto.randomUUID()}`;
    adapter.enqueue(async () => {
      adapter.report(await hooks.turnProgress({
        session: adapter.sessionObject(),
        turn: adapter.turnObject(turn),
        item: { id: item, synthesized: true },
        delta: { id: piece, role: "assistant", synthesized: true, parts: partsOf(piece, delta.delta) } as never,
        final: false,
      }));
    });
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    adapter.ctx = ctx;
    const turn = adapter.turn;
    if (!turn || event.outcome !== "completed") return;
    const hooks = adapter.client("turn.finish.before");
    if (!hooks) return;
    await adapter.flush();
    const continuable = turn.continuationCount < MAX_CONTINUATIONS;
    const result = await hooks.turnFinishBefore({
      session: adapter.sessionObject(),
      turn: adapter.turnObject(turn),
      items: answerItems(turn) as never,
      continuationCount: turn.continuationCount,
      outcome: "completed",
    }, {
      initialState: state.initial(Permission.None),
      // After the limit a backend may only stop.
      ...(continuable ? {} : { capabilities: { effects: ["flow", "message"], flow: { operations: ["stop"] } } as never }),
    });
    adapter.report(result);
    const decision = flow(result);
    if (decision?.operation === "stop") {
      adapter.notify(decision.reason);
      return { continue: false };
    }
    if (decision?.operation !== "continue" || !continuable) return;
    turn.continuationCount += 1;
    const text = decision.instruction ?? "Continue: an AHP hook asked for another pass.";
    return {
      entries: [...event.entries, { type: "custom_message" as const, ...adapter.customMessage(text) }],
      continue: true,
    };
  });

  pi.on("agent_settled", async (event, ctx) => {
    adapter.ctx = ctx;
    await adapter.flush();
    const turn = adapter.turn;
    if (!turn) return;
    // A backend's refusal is carried out by an abort, but the turn failed by it.
    if ((event as { aborted?: boolean }).aborted && !turn.refused) turn.cancelled = true;
    await endTurn(adapter, turn.refused ? "failed" : turn.cancelled ? "cancelled" : turn.error ? "failed" : "completed");
  });
}

function answerItems(turn: Turn): Message[] {
  if (!turn.answer) return [];
  const { id, text } = turn.answer;
  return [{ id, role: "assistant", synthesized: true, parts: partsOf(id, text) }];
}

/** The turn is over, whichever way. */
export async function endTurn(adapter: Adapter, outcome: "completed" | "failed" | "cancelled"): Promise<void> {
  const turn = adapter.turn;
  if (!turn) return;
  adapter.turn = undefined;
  const hooks = adapter.client("turn.end");
  if (!hooks) return;
  adapter.report(await hooks.turnEnd({
    session: adapter.sessionObject(),
    turn: adapter.turnObject(turn),
    items: answerItems(turn) as never,
    continuationCount: turn.continuationCount,
    outcome,
    ...(outcome === "failed" && turn.error ? { error: turn.error } : {}),
    extensions: { [EXTENSION]: { sessionId: adapter.sessionId } },
  }));
}
