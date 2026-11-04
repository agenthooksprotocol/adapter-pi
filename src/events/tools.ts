// Tools: tool.before at tool_call, tool.after at tool_result, and at
// tool_execution_end for the calls that never reached it (unknown tools, bad
// arguments, aborts). pi has no permission system: a backend's `ask` is answered
// by a dialog, and is not advertised where pi has no UI.
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Permission, state } from "agenthooksprotocol/client";
import { type Adapter, type CallState } from "../adapter.js";
import { applyParts, asText, json, message, partsOf, texts, type Block, type Message, type Part } from "../content.js";
import { denial, eventId, flow, injections, supplied } from "../effects.js";
import { connection } from "../mcp.js";

const BUILT_IN_MCP = "builtin:mcp";
const FILE_TOOLS = new Set(["write", "edit"]);
/** What tool.before can do for a call a script made. */
const nestedCall = (hasUI: boolean) => ({
  effects: ["deny", "allow", ...(hasUI ? ["ask"] : []), "modify", "inject", "message"],
  inject: { context: { append: true, deliverAt: ["now"] } },
  modify: { input: { merge: true, replace: true } },
});

/** How the tool is described: pi's built-in MCP puts a server's tools under the
 * server's namespace; the configuration says where the server is. */
export function descriptor(adapter: Adapter, name: string) {
  const info = adapter.pi.getAllTools().find((tool) => tool.name === name);
  const namespace = info?.namespace?.name;
  if (info?.sourceInfo.path !== BUILT_IN_MCP || !namespace) return { name, origin: "native" as const, path: "native" as const, toolMcp: undefined };
  // pi keeps only the sanitized name in a tool's: the configuration has the real one.
  const sanitized = namespace.replace(/^mcp__/, "");
  const server = [...adapter.mcp.keys()].find((name) => name.replace(/[^a-zA-Z0-9_]/g, "_") === sanitized) ?? sanitized;
  return {
    name,
    origin: "mcp" as const,
    path: "mcp" as const,
    toolMcp: {
      provenance: "inferred" as const,
      server: { id: server, name: server },
      toolName: name.slice(namespace.length + 2),
      connection: json<never>(connection(adapter.mcp.get(server))),
    },
  };
}

function track(adapter: Adapter, id: string, name: string, input: Record<string, unknown>): CallState {
  const call: CallState = { id, name, input, context: [] };
  adapter.calls.set(id, call);
  return call;
}

function replaceInPlace(target: Record<string, unknown>, value: Record<string, unknown>): void {
  for (const key of Object.keys(target)) if (!(key in value)) delete target[key];
  Object.assign(target, value);
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function base(adapter: Adapter, call: CallState) {
  return {
    callId: call.id,
    ...descriptor(adapter, call.name),
    ...adapter.scope(),
    ...(call.beforeEventId ? { parentEventId: call.beforeEventId } : {}),
  };
}

type AfterFields = {
  outcome: "ok" | "error" | "denied" | "cancelled";
  execution: { status: "executed" } | { status: "skipped"; reason: "policy" | "cancelled" | "supplied_result" | "other"; detail?: string };
  items: Message[];
  error?: { class: string; message: string };
  durationMs?: number;
};

async function after(adapter: Adapter, call: CallState, fields: AfterFields) {
  call.afterSent = true;
  adapter.resolved.set(call.id, { outcome: fields.outcome, execution: fields.execution });
  const hooks = adapter.client("tool.after");
  if (!hooks) return undefined;
  const result = await hooks.toolAfter(
    { ...base(adapter, call), input: json(call.input), ...fields } as never,
    // An aborted signal would stop the delivery: a call that resolved is still reported.
    { initialState: state.initial(Permission.None), ...(adapter.ctx.signal && !adapter.ctx.signal.aborted ? { signal: adapter.ctx.signal } : {}) },
  );
  adapter.report(result);
  return result;
}

/** Whether the file a tool will write is there, before it writes. */
function noteTarget(adapter: Adapter, call: CallState): void {
  if (!FILE_TOOLS.has(call.name)) return;
  const path = target(adapter, call.input);
  call.existed = path ? existsSync(path) : false;
}

function target(adapter: Adapter, input: Record<string, unknown>): string | undefined {
  const path = input.path;
  if (typeof path !== "string") return undefined;
  return isAbsolute(path) ? path : resolve(adapter.cwd, path);
}

export function tools(adapter: Adapter): void {
  const { pi } = adapter;

  // First of a call's events: the name and arguments, whatever becomes of it.
  pi.on("tool_execution_start", (event, ctx) => {
    adapter.ctx = ctx;
    track(adapter, event.toolCallId, event.toolName, (event.args ?? {}) as Record<string, unknown>);
  });

  pi.on("tool_call", async (event, ctx) => {
    adapter.ctx = ctx;
    await adapter.flush();
    const input = event.input as Record<string, unknown>;
    const call = adapter.calls.get(event.toolCallId) ?? track(adapter, event.toolCallId, event.toolName, input);
    call.input = input;
    const parent = event.parentToolCallId ? adapter.calls.get(event.parentToolCallId) : undefined;
    if (parent?.beforeEventId) call.beforeEventId = parent.beforeEventId;
    const hooks = adapter.client("tool.before");
    noteTarget(adapter, call);
    if (!hooks) return;
    const nested = Boolean(event.parentToolCallId);
    const result = await hooks.toolBefore(
      {
        callId: call.id,
        ...descriptor(adapter, call.name),
        ...adapter.scope(),
        input: json(input),
        ...(call.beforeEventId ? { parentEventId: call.beforeEventId } : {}),
      },
      {
        initialState: state.initial(Permission.None),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        // A nested call has no result message for `return` to become.
        ...(nested ? { capabilities: nestedCall(ctx.hasUI) as never } : {}),
      },
    );
    adapter.report(result);
    const id = eventId(result);
    if (id) call.beforeEventId = id;

    // pi's own abort, in flight: the call is over, and nobody refused it.
    if (result.interrupted) {
      await after(adapter, call, { outcome: "cancelled", execution: { status: "skipped", reason: "cancelled" }, items: [] });
      return { block: true, reason: "Operation aborted" };
    }
    const refused = denial(result);
    if (refused !== undefined) return refuse(adapter, call, refused);
    call.context.push(...injections(result));

    const rewrittenInput = (result.event as { tool?: { input?: unknown } }).tool?.input;
    if (rewrittenInput && typeof rewrittenInput === "object" && !sameJson(rewrittenInput, input)) replaceInPlace(input, rewrittenInput as Record<string, unknown>);
    noteTarget(adapter, call);

    // Asking comes first: a result a backend supplies is still this call going ahead.
    if ((result.state as { permission?: string }).permission === Permission.Ask) {
      const answer = await askPermission(adapter, call, ctx);
      noteTarget(adapter, call);
      if (answer.refused !== undefined) {
        const refusal = await refuse(adapter, call, answer.refused);
        if (answer.stop) ctx.abort();
        return refusal;
      }
    }

    const candidate = supplied(result);
    if (candidate) {
      const text = suppliedText(candidate.value);
      const answered = await after(adapter, call, {
        outcome: "ok",
        execution: { status: "skipped", reason: "supplied_result" },
        items: [message(`${call.id}:result`, "tool", text)],
      });
      const effective = answered ? texts((answered.event as { items?: unknown[] }).items).join("\n") : text;
      call.supplied = [effective, ...call.context, ...(answered ? injections(answered) : [])].filter(Boolean).join("\n\n");
      // Not executed, so no tool_result: the block's message is rewritten at message_end.
      return { block: true, reason: call.supplied };
    }
    return undefined;
  });

  pi.on("tool_execution_update", (event, ctx) => {
    adapter.ctx = ctx;
    const hooks = adapter.client("tool.progress");
    const call = adapter.calls.get(event.toolCallId);
    if (!hooks || !call) return;
    const output = texts([{ parts: partsOf("p", (event.partialResult as { content?: readonly Block[] } | undefined)?.content) }]).join("\n");
    if (!output) return;
    const piece = `${call.id}:progress:${crypto.randomUUID()}`;
    adapter.enqueue(async () => {
      adapter.report(await hooks.toolProgress({
        ...base(adapter, call),
        input: json(call.input),
        partialOutput: message(piece, "tool", output, { synthesized: true }) as never,
        backgrounded: false,
      }));
    });
  });

  pi.on("tool_result", async (event, ctx) => {
    adapter.ctx = ctx;
    await adapter.flush();
    const call = adapter.calls.get(event.toolCallId);
    if (!call) return;
    const id = `${call.id}:result`;
    const content = event.content as readonly Block[];
    const original = partsOf(id, content);
    const interrupted = event.isError && Boolean(ctx.signal?.aborted);
    const result = await after(adapter, call, !event.isError
      ? { outcome: "ok", execution: { status: "executed" }, items: [{ id, role: "tool", parts: original }] }
      : interrupted
        // tool_result fires only after the tool ran: it did, whatever it left behind.
        ? { outcome: "cancelled", execution: { status: "executed" }, items: [] }
        : { outcome: "error", execution: { status: "executed" }, items: [], error: { class: "ToolError", message: texts([{ parts: original }]).join("\n") || "The tool reported an error" } });
    if (!event.isError) await fileChanged(adapter, call);
    const effective = result ? (result.event as { items?: { id?: string; parts?: Part[] }[] }).items : undefined;
    // A failure's event has no items: what the model reads stays, unless a backend gave some.
    const next = effective && (!event.isError || effective.length) ? applyOutput(id, content, effective) : content;
    const context = [...call.context, ...(result ? injections(result) : [])];
    const final = context.length ? withContext(next, context) : next;
    return final === content ? undefined : { content: final as never };
  });

  // Every finalized call ends here, whether or not it reached the hooks above.
  pi.on("tool_execution_end", async (event, ctx) => {
    adapter.ctx = ctx;
    await adapter.flush();
    const known = adapter.calls.get(event.toolCallId);
    if (known?.afterSent) {
      // A nested call has no result message to clear it at message_end.
      if ((event as { parentToolCallId?: string }).parentToolCallId) adapter.calls.delete(known.id);
      return;
    }
    const call = known ?? track(adapter, event.toolCallId, event.toolName, {});
    const text = texts([{ parts: partsOf("r", (event.result as { content?: readonly Block[] } | undefined)?.content) }]).join("\n");
    const result = await after(adapter, call, ctx.signal?.aborted
      ? { outcome: "cancelled", execution: { status: "skipped", reason: "cancelled" }, items: [] }
      : { outcome: "error", execution: { status: "skipped", reason: "other", detail: text }, items: [], error: { class: "ToolError", message: text || "The tool did not run" } });
    // Context for the model has no result to ride on: it joins the next request.
    adapter.turn?.context.push(...call.context, ...(result ? injections(result) : []));
  });

  // A model request and its tool calls have finished.
  pi.on("turn_end", async (event, ctx) => {
    adapter.ctx = ctx;
    const results = event.toolResults as unknown as { toolCallId: string; toolName: string; isError: boolean }[];
    if (!results.length || !adapter.turn) return;
    const hooks = adapter.client("tool.batch.after");
    if (!hooks) return;
    await adapter.flush();
    const calls = blocksOf(event.message).filter((block) => block.type === "toolCall");
    const resolved = adapter.resolved;
    adapter.resolved = new Map();
    const result = await hooks.toolBatchAfter({
      ...adapter.scope(),
      batch: { id: `${adapter.turn.id}:${adapter.turn.requests}:batch`, synthesized: true },
      calls: results.map((item) => {
        const { origin, path, toolMcp } = descriptor(adapter, item.toolName);
        return {
          call: { id: item.toolCallId },
          tool: { name: item.toolName, origin, ...(toolMcp ? { mcp: toolMcp } : {}), input: json<{ [key: string]: never }>(calls.find((block) => block.id === item.toolCallId)?.arguments ?? {}) },
          path,
          outcome: resolved.get(item.toolCallId)?.outcome ?? (item.isError ? "error" as const : "ok" as const),
          execution: resolved.get(item.toolCallId)?.execution ?? { status: "executed" as const },
        };
      }),
    }, { initialState: state.initial(Permission.None) });
    adapter.report(result);
    const decision = flow(result);
    if (decision?.operation === "stop") {
      adapter.turn.cancelled = true;
      adapter.notify(decision.reason, "warning");
      ctx.abort();
      return;
    }
    const context = injections(result);
    if (!context.length) return;
    return { entries: [...event.entries, ...context.map((text) => ({ type: "custom_message" as const, ...adapter.customMessage(text) }))] };
  });
}

function blocksOf(native: unknown): readonly Block[] {
  const content = (native as { content?: string | readonly Block[] }).content;
  return typeof content === "string" ? [] : content ?? [];
}

function suppliedText(value: unknown): string {
  return typeof value === "string" ? value : texts(value as unknown[]).join("\n") || asText(value);
}

async function refuse(adapter: Adapter, call: CallState, reason: string) {
  const result = await after(adapter, call, { outcome: "denied", execution: { status: "skipped", reason: "policy" }, items: [] });
  // The refusal is the result the model reads: context travels with it.
  return { block: true, reason: [reason, ...(result ? injections(result) : [])].join("\n\n") };
}

/** The result's effective content: `replace` gives one message for the result;
 * `merge` appends more, each read as more of the same result. */
function applyOutput(id: string, content: readonly Block[], effective: readonly { id?: string; parts?: Part[] }[]): readonly Block[] {
  const own = effective.find((item) => item.id === id);
  const merged = effective.filter((item) => item !== own).flatMap((item) => item.parts ?? []);
  const parts = [...(own?.parts ?? []), ...merged];
  return applyParts(id, content, parts);
}

function withContext(content: readonly Block[], context: readonly string[]): Block[] {
  return [...content, ...context.map((text) => ({ type: "text", text }))];
}

/** The tool's own change: pi watches no files. */
async function fileChanged(adapter: Adapter, call: CallState): Promise<void> {
  if (!FILE_TOOLS.has(call.name)) return;
  const hooks = adapter.client("file.changed");
  const path = target(adapter, call.input);
  if (!hooks || !path) return;
  adapter.report(await hooks.fileChanged({
    ...adapter.scope(),
    changes: [{ path, operation: call.existed ? "update" : "create", agentCaused: true }],
  }));
}

/** A backend asked for a decision: other backends may give one at
 * tool.permission.request; failing that, a person does. */
async function askPermission(adapter: Adapter, call: CallState, ctx: ExtensionContext): Promise<{ refused?: string; stop?: boolean }> {
  const resolved = async (decision: "allow" | "deny", decidedBy: "user" | "hook") => {
    const hooks = adapter.client("tool.permission.resolved");
    if (hooks) adapter.report(await hooks.toolPermissionResolved({ ...base(adapter, call), input: json(call.input), decision, decidedBy }));
  };
  const hooks = adapter.client("tool.permission.request");
  if (hooks) {
    const result = await hooks.toolPermissionRequest({
      ...base(adapter, call),
      input: json(call.input),
      suggestions: [],
      sandboxBypass: false,
    }, { initialState: state.initial(Permission.None) });
    adapter.report(result);
    const stop = flow(result)?.operation === "stop";
    const refused = denial(result);
    if (refused !== undefined || stop) {
      const reason = refused ?? "Stopped by an AHP hook";
      await resolved("deny", "hook");
      return { refused: reason, stop };
    }
    const rewrittenInput = (result.event as { tool?: { input?: unknown } }).tool?.input;
    if (rewrittenInput && typeof rewrittenInput === "object" && !sameJson(rewrittenInput, call.input)) replaceInPlace(call.input, rewrittenInput as Record<string, unknown>);
    if ((result.state as { permission?: string }).permission === Permission.Allow) {
      await resolved("allow", "hook");
      return {};
    }
  }
  adapter.asking = true;
  const confirmed = await ctx.ui.confirm(`Allow ${call.name}?`, asText(call.input), ctx.signal ? { signal: ctx.signal } : undefined)
    .finally(() => {
      adapter.asking = false;
    });
  await resolved(confirmed ? "allow" : "deny", "user");
  return confirmed ? {} : { refused: "The person declined this tool call" };
}
