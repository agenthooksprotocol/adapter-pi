// Session lifecycle, compaction, and the settings pi reports.
import { compact, type CompactionResult, type ExtensionContext, type SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { Permission, state } from "agenthooksprotocol/client";
import type { Adapter } from "../adapter.js";
import { canonical, message, textPart, texts, type NativeMessage } from "../content.js";
import { denial, describe, injections, supplied } from "../effects.js";
import { endTurn } from "./turns.js";

const TRIGGERS = { startup: "startup", new: "clear", resume: "resume", fork: "fork" } as const;

/** A session file is named after its session. */
function sessionIdOf(file: string | undefined): string | undefined {
  return file?.match(/_([^_/\\]+)\.jsonl$/)?.[1];
}

export function lifecycle(adapter: Adapter): void {
  const { pi } = adapter;

  let started = false;
  pi.on("session_start", async (event, ctx) => {
    // pi 1.x raises this twice on one instance after an RPC new_session.
    if (started) return;
    started = true;
    await adapter.start(ctx);
    // A reload is the same session under a new extension instance.
    if (event.reason === "reload") return;
    const hooks = adapter.client("session.start");
    if (!hooks) return;
    const system = ctx.getSystemPrompt();
    const parent = event.reason === "new" || event.reason === "fork" ? sessionIdOf(event.previousSessionFile) : undefined;
    // AHP requires the session a clear or fork came from. One that was never
    // saved has no identity left: all that is known is that a session starts.
    const trigger = (event.reason === "new" || event.reason === "fork") && !parent ? "startup" : TRIGGERS[event.reason];
    const result = await hooks.sessionStart({
      session: adapter.sessionObject(),
      trigger,
      permissionMode: "default",
      items: system ? [message(`${adapter.sessionId}:system`, "system", system, { category: "system", synthesized: true })] : [],
      ...(parent ? { resumedFrom: { id: parent } } : {}),
    }, { initialState: state.initial(Permission.None) });
    adapter.report(result);
    // Rides on the session's first prompt.
    for (const text of injections(result)) pi.sendMessage(adapter.customMessage(text), { deliverAs: "nextTurn" });
  });

  pi.on("session_shutdown", async (event, ctx) => {
    adapter.ctx = ctx;
    await adapter.flush();
    if (adapter.turn) await endTurn(adapter, "cancelled");
    if (event.reason !== "reload") {
      const hooks = adapter.client("session.end");
      if (hooks) {
        adapter.report(await hooks.sessionEnd({
          session: adapter.sessionObject(),
          reason: event.reason,
          outcome: "completed",
        }));
      }
    }
    await adapter.close();
  });

  pi.on("session_before_compact", async (event, ctx) => {
    adapter.ctx = ctx;
    const hooks = adapter.client("context.compact.before");
    if (!hooks) return;
    await adapter.flush();
    const { preparation } = event;
    const original = event.customInstructions;
    const seen = new Map<string, number>();
    const items = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]
      .map((native) => canonical(adapter.sessionId, native as NativeMessage, seen));
    const result = await hooks.contextCompactBefore({
      ...adapter.scope(),
      trigger: event.reason === "manual" ? "manual" : "auto",
      items: items as never,
      instructions: original ? [textPart(`${adapter.sessionId}:compact:instructions`, original, "instructions")] : [],
    }, { initialState: state.initial(Permission.None), signal: event.signal });
    adapter.report(result);
    // pi's own abort, in flight: its failure event reports it as cancelled.
    if (result.interrupted) return { cancel: true };
    const refused = denial(result);
    if (refused !== undefined) {
      adapter.compactionRefused = true;
      adapter.notify(refused, "warning");
      return { cancel: true };
    }
    const candidate = supplied(result);
    if (candidate) {
      return {
        compaction: {
          summary: texts([{ parts: candidate.value }]).join("\n"),
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
        },
      };
    }
    const effective = texts([{ parts: (result.event as { instructions?: unknown[] }).instructions }]).join("\n");
    if (effective === (original ?? "")) return;
    // pi passes on no instructions a handler changes: run its own compaction with them.
    const compaction = await withInstructions(adapter, event, ctx, effective);
    return compaction ? { compaction } : undefined;
  });

  pi.on("session_compact", async (event, ctx) => {
    adapter.ctx = ctx;
    const hooks = adapter.client("context.compact.after");
    if (!hooks) return;
    const entry = event.compactionEntry;
    adapter.report(await hooks.contextCompactAfter({
      ...adapter.scope(),
      summary: [textPart(`${entry.id}:summary`, entry.summary, "summary")],
      removed: [],
      execution: { status: "executed" },
      tokenCounts: { before: entry.tokensBefore },
      gaps: [{ path: "removed", reason: "pi reports the first entry it kept, not the messages a compaction replaced" }],
    }));
  });

  pi.on("session_compact_failed", async (event, ctx) => {
    adapter.ctx = ctx;
    // A refusal was the backend's own: nothing happened to report.
    if (adapter.compactionRefused) {
      adapter.compactionRefused = false;
      return;
    }
    const hooks = adapter.client("context.compact.after");
    if (!hooks) return;
    adapter.report(await hooks.contextCompactAfter({
      ...adapter.scope(),
      summary: [],
      removed: [],
      execution: event.aborted
        ? { status: "skipped", reason: "cancelled" }
        : { status: "skipped", reason: "other", detail: event.errorMessage ?? "Compaction failed" },
    }));
  });

  pi.on("thinking_level_select", async (event, ctx) => {
    adapter.ctx = ctx;
    const hooks = adapter.client("config.change.after");
    if (!hooks) return;
    await adapter.flush();
    adapter.report(await hooks.configChangeAfter({
      ...adapter.scope(),
      change: {
        scope: "session",
        source: "pi",
        settings: ["thinkingLevel"],
        summary: `thinking level ${event.previousLevel} -> ${event.level}`,
      },
    }));
  });

  // Not awaited by pi: a dialog does not wait for its report.
  pi.on("ui_prompt_start", (event, ctx) => {
    adapter.ctx = ctx;
    const hooks = adapter.client("user.attention");
    if (!hooks) return;
    const id = `${adapter.sessionId}:prompt:${crypto.randomUUID()}`;
    const kind = adapter.asking ? "permission" : "input";
    const title = event.title ?? event.kind;
    adapter.enqueue(async () => {
      adapter.report(await hooks.userAttention({
        ...adapter.scope(),
        attention: {
          kind,
          title: [textPart(`${id}:title`, title)],
          message: [textPart(`${id}:message`, title)],
        },
        synthesized: true,
      }));
    });
  });
}

async function withInstructions(adapter: Adapter, event: SessionBeforeCompactEvent, ctx: ExtensionContext, instructions: string): Promise<CompactionResult | undefined> {
  const model = ctx.model;
  if (!model) return undefined;
  try {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) throw new Error(auth.error);
    return await compact(event.preparation, model, auth.apiKey, auth.headers as Record<string, string> | undefined, instructions, event.signal, undefined, undefined, auth.env);
  } catch (error) {
    adapter.warn(`A compaction ran without a hook's instructions: ${describe(error)}`);
    return undefined;
  }
}
