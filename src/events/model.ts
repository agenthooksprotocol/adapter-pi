// Model requests: model.request.before at `context`, whose messages are that
// request's own copy of the transcript; the response at message_end, before it is
// recorded; selections at model_select, which fires once they have happened.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Permission, state } from "agenthooksprotocol/client";
import { type Adapter, CUSTOM_TYPE, type Turn } from "../adapter.js";
import { applyMessage, applyParts, blocks, canonical, customKey, messageId, textPart, texts, type Block, type Message, type NativeMessage, type Part } from "../content.js";
import { denial, injections } from "../effects.js";

type Assistant = NativeMessage & {
  role: "assistant";
  provider: string;
  model: string;
  stopReason: string;
  errorMessage?: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
};

type SystemMessage = { timestamp?: number; toolsAdded?: { name: string }[]; toolsRemoved?: { name: string }[] };

function attempt(turn: Turn) {
  return { id: `${turn.id}:${turn.requests}`, number: turn.failures + 1, synthesized: true };
}

function custom(text: string) {
  return { role: "custom" as const, customType: CUSTOM_TYPE, content: text, display: false, timestamp: Date.now() };
}

/** pi says an abort this way when no response had begun. */
function aborted(message: Assistant, ctx: ExtensionContext): boolean {
  return message.stopReason === "aborted" || Boolean(ctx.signal?.aborted);
}

export function model(adapter: Adapter): void {
  const { pi } = adapter;

  pi.on("context", async (event, ctx) => {
    adapter.ctx = ctx;
    const turn = adapter.turn;
    if (!turn) return;
    // A refused run a first abort came too early for.
    if (turn.cancelled) {
      ctx.abort();
      return;
    }
    await adapter.flush();
    turn.requests += 1;
    turn.system = undefined;
    const context = [...turn.context];
    let natives = event.messages as unknown as NativeMessage[];
    let messages: readonly unknown[] = event.messages;
    let changed = false;
    // Saved before a backend refused them: the model does not read them later either.
    if (adapter.refusedMessages.size) {
      natives = natives.filter((native) => native.role !== "custom" || !adapter.refusedMessages.has(customKey(native.customType, native.content)));
      changed = natives.length !== messages.length;
      messages = natives;
    }
    const selected = ctx.model;
    const hooks = adapter.client("model.request.before");
    if (hooks && selected) {
      const seen = new Map<string, number>();
      const items = natives.map((native) => native.excludeFromContext ? undefined : canonical(adapter.sessionId, native, seen));
      const visible = items.filter((item) => item !== undefined);
      const systemId = `${attempt(turn).id}:system`;
      const system = ctx.getSystemPrompt();
      const result = await hooks.modelRequestBefore({
        ...adapter.scope(),
        model: { id: selected.id, provider: selected.provider },
        attempt: attempt(turn),
        params: { model: selected.id, thinkingLevel: pi.getThinkingLevel() },
        items: [{ id: systemId, role: "system", synthesized: true, parts: [textPart(`${systemId}#0`, system, "system")] } satisfies Message, ...visible] as never,
        gaps: [{ path: "params", reason: "AHP's modify targets messages: options are reported but not rewritten" }],
      }, { initialState: state.initial(Permission.None), ...(ctx.signal ? { signal: ctx.signal } : {}) });
      adapter.report(result);
      // pi's own abort, in flight: the request will not be sent, and nobody refused it.
      if (result.interrupted) {
        turn.cancelled = true;
        return;
      }
      const refused = denial(result);
      if (refused !== undefined) {
        // A handler's throw does not stop a request: an abort does, before it is sent.
        turn.error = { class: "Denied", message: refused };
        turn.refused = true;
        adapter.notify(refused, "error");
        ctx.abort();
        return;
      }
      const effective = (result.event as { items?: { id: string; role?: string; parts?: Part[] }[] }).items;
      if (effective) {
        const next = applyRequest(natives, items, effective);
        if (next) {
          messages = next;
          changed = true;
        }
        const chosen = effective.find((item) => item.id === systemId);
        const text = chosen ? texts([chosen]).join("\n") : "";
        if (chosen && text !== system) turn.system = text;
      }
      // Lasts for the turn. A backend that injects at every request has said it once.
      for (const text of injections(result)) {
        if (turn.context.includes(text)) continue;
        turn.context.push(text);
        context.push(text);
      }
    }
    if (context.length) {
      messages = [...messages, ...context.map(custom)];
      changed = true;
    }
    return changed ? { messages: messages as never } : undefined;
  });

  // The system prompt a backend chose, for this request alone.
  pi.on("context_with_system", (event, ctx) => {
    adapter.ctx = ctx;
    const system = adapter.turn?.system;
    if (system === undefined) return;
    adapter.turn!.system = undefined;
    // The leading message holds the prompt and, in pi 1.x, the tools: those stay.
    const systems = event.messages.filter((message) => message.role === "system") as unknown as SystemMessage[];
    const tools = new Map<string, unknown>();
    for (const message of systems) {
      for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
      for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
    }
    const replacement = { role: "system", content: system, timestamp: systems[0]?.timestamp ?? Date.now(), ...(tools.size ? { toolsAdded: [...tools.values()] } : {}) };
    return { messages: [replacement, ...event.messages.filter((message) => message.role !== "system")] } as never;
  });

  pi.on("message_end", async (event, ctx) => {
    adapter.ctx = ctx;
    const native = event.message as unknown as NativeMessage;
    if (native.role === "toolResult") return suppliedResult(adapter, native);
    if (native.role !== "assistant") return;
    const turn = adapter.turn;
    if (!turn || turn.refused) return;
    await adapter.flush();
    const message = native as Assistant;
    const selected = { id: message.model, provider: message.provider };
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      if (aborted(message, ctx)) {
        turn.cancelled = true;
        return;
      }
      turn.error = { class: "ProviderError", message: message.errorMessage ?? "The model request failed" };
      const current = attempt(turn);
      turn.failures += 1;
      const hooks = adapter.client("model.error");
      if (hooks) {
        adapter.report(await hooks.modelError({
          ...adapter.scope(),
          model: selected,
          attempt: current,
          execution: { status: "executed" },
          error: turn.error,
        }));
      }
      return;
    }
    // A retry that worked: the failure before it does not decide the turn.
    turn.error = undefined;
    const current = attempt(turn);
    turn.failures = 0;
    const id = messageId(adapter.sessionId, message);
    let content = blocks(message.content);
    const hooks = adapter.client("model.response.after");
    if (hooks) {
      const result = await hooks.modelResponseAfter({
        ...adapter.scope(),
        model: selected,
        attempt: current,
        execution: { status: "executed" },
        finishReason: message.stopReason,
        items: [canonical(adapter.sessionId, message)] as never,
        usage: {
          kind: "amount",
          scope: "attempt",
          provenance: "provider",
          completeness: "complete",
          inputTokens: message.usage.input,
          outputTokens: message.usage.output,
          ...(message.usage.cacheRead ? { cacheReadTokens: message.usage.cacheRead } : {}),
          ...(message.usage.cacheWrite ? { cacheWriteTokens: message.usage.cacheWrite } : {}),
        },
      }, { initialState: state.initial(Permission.None) });
      adapter.report(result);
      const items = (result.event as { items?: { id: string; parts?: Part[] }[] }).items;
      // A replacement under another id takes the place of the whole response.
      const own = items?.find((item) => item.id === id);
      if (items) content = applyParts(id, content, own ? own.parts : items.flatMap((item) => item.parts ?? []));
    }
    const answer = content.filter((block: Block) => block.type === "text").map((block: Block) => block.text ?? "").join("\n");
    if (answer) turn.answer = { id, text: answer };
    if (content === blocks(message.content)) return undefined;
    // With its calls left out, a response asked for nothing: pi must not wait on tools.
    const asksForTools = content.some((block: Block) => block.type === "toolCall");
    return { message: { ...event.message, content, ...(message.stopReason === "toolUse" && !asksForTools ? { stopReason: "stop" } : {}) } as never };
  });

  pi.on("model_select", async (event, ctx) => {
    adapter.ctx = ctx;
    const next = { id: event.model.id, provider: event.model.provider };
    if (adapter.reverting) {
      adapter.model = next;
      return;
    }
    const previous = event.previousModel;
    if (!previous || (previous.id === next.id && previous.provider === next.provider)) {
      adapter.model = next;
      return;
    }
    await adapter.flush();
    const current = { id: previous.id, provider: previous.provider };
    const before = adapter.client("model.switch.before");
    if (before) {
      const result = await before.modelSwitchBefore({
        ...adapter.scope(),
        current,
        proposed: next,
        reason: event.source,
      }, { initialState: state.initial(Permission.None) });
      adapter.report(result);
      const refused = denial(result);
      if (refused !== undefined) {
        adapter.reverting = true;
        const restored = await pi.setModel(previous).finally(() => {
          adapter.reverting = false;
        });
        adapter.notify(restored ? refused : `${refused} (and the previous model could not be restored)`, "error");
        if (restored) return;
      }
    }
    adapter.model = next;
    const after = adapter.client("model.switch.after");
    if (after) adapter.report(await after.modelSwitchAfter({ ...adapter.scope(), previous: current, current: next, reason: event.source }));
  });
}

/** A blocked call's message becomes the result the backend supplied. */
function suppliedResult(adapter: Adapter, native: NativeMessage) {
  const call = native.toolCallId ? adapter.calls.get(native.toolCallId) : undefined;
  if (!call) return;
  adapter.calls.delete(call.id);
  if (call.supplied === undefined) return;
  return { message: { ...native, content: [{ type: "text", text: call.supplied }], isError: false } as never };
}

/** The effective request onto this request's own copy: a message left out goes,
 * and one the transcript does not have becomes a custom message. */
function applyRequest(natives: readonly NativeMessage[], items: readonly (Message | undefined)[], effective: readonly { id: string; role?: string; parts?: Part[] }[]): unknown[] | undefined {
  const byId = new Map(effective.map((item) => [item.id, item]));
  let changed = false;
  const next: unknown[] = [];
  natives.forEach((native, index) => {
    const item = items[index];
    // Not reported, because the model does not read it: not the backend's to change.
    if (!item) {
      next.push(native);
      return;
    }
    const found = byId.get(item.id);
    if (!found) {
      changed = true;
      return;
    }
    const applied = applyMessage(item.id, native, found.parts);
    if (applied !== native) changed = true;
    next.push(applied);
  });
  const known = new Set(items.map((item) => item?.id));
  for (const item of effective) {
    if (known.has(item.id) || item.role === "system") continue;
    const text = texts([item]).join("\n");
    if (!text) continue;
    changed = true;
    next.push(custom(text));
  }
  return changed ? next : undefined;
}
