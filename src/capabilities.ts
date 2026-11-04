// What this adapter can enforce through pi's extension API, and what it cannot.
// Everything here is optional for an AHP runtime: an event or effect left out is
// simply not advertised, and the gaps say why.
import { capabilityCount, type HostCapabilities } from "agenthooksprotocol/client";

/** Continuations a backend may ask for in one turn. pi sets no limit of its own:
 * a boundary that keeps asking would otherwise loop for ever. */
export const MAX_CONTINUATIONS = 8;

const injectNow = { context: { append: true, deliverAt: ["now"] } } as const;

export const capabilities = {
  // session_start: a next-turn message carries context to the first prompt.
  sessionStart: { observe: true, intercept: { inject: injectNow, message: true } },
  sessionEnd: { observe: true },

  // input refuses and rewrites a prompt; before_agent_start adds to it.
  turnStart: {
    observe: true,
    intercept: { deny: true, modifyPrompt: "replace", inject: injectNow, message: true },
  },
  turnProgress: { observe: true },
  // agent_before_settle: a custom message and continue: true make another pass.
  turnFinishBefore: {
    observe: true,
    intercept: {
      flow: {
        operations: ["continue", "stop"],
        remainingContinuations: capabilityCount(MAX_CONTINUATIONS),
        continuationCount: capabilityCount(0),
        maxContinuations: capabilityCount(MAX_CONTINUATIONS),
      },
      message: true,
    },
  },
  turnEnd: { observe: true },

  // context and context_with_system: each request's own copy of the transcript.
  modelRequestBefore: {
    observe: true,
    intercept: { deny: true, modifyRequest: "replace", inject: injectNow, message: true },
  },
  // message_end replaces what is recorded and what the model reads next.
  modelResponseAfter: { observe: true, intercept: { modifyResponse: "replace", message: true } },
  modelError: { observe: true },
  // model_select fires once selected: setting the previous model back refuses it.
  modelSwitchBefore: { observe: true, intercept: { deny: true, message: true } },
  modelSwitchAfter: { observe: true },

  // tool_call blocks and edits input in place; message_end turns a block into a
  // supplied result. A dialog is the permission stage, since pi has none of its
  // own: `withoutUI` takes `ask` away where there is nobody to answer it.
  toolBefore: {
    observe: true,
    intercept: {
      deny: true,
      allow: true,
      ask: true,
      modifyInput: "replace-and-merge",
      returnResult: true,
      inject: injectNow,
      message: true,
    },
  },
  toolAfter: {
    observe: true,
    intercept: { modifyOutput: "replace-and-merge", inject: injectNow, message: true },
  },
  toolProgress: { observe: true },
  // turn_end takes custom messages; an abort ends the turn after the batch.
  toolBatchAfter: {
    observe: true,
    intercept: { inject: injectNow, flow: { operations: ["stop"] }, message: true },
  },
  toolPermissionRequest: {
    observe: true,
    intercept: { allow: true, deny: true, modifyInput: "replace-and-merge", flow: { operations: ["stop"] }, message: true },
  },
  toolPermissionResolved: { observe: true },

  // session_before_compact cancels, supplies a summary, or runs pi's own
  // compaction with other instructions.
  contextCompactBefore: {
    observe: true,
    intercept: { deny: true, modifyInstructions: "replace-and-merge", returnResult: true, message: true },
  },
  contextCompactAfter: { observe: true },

  configChangeAfter: { observe: true },
  fileChanged: { observe: true },
  userAttention: { observe: true },
  userMessageInbound: { observe: true, intercept: { deny: true, modifyPrompt: "replace", message: true } },
  hookFailure: { observe: true },
} satisfies HostCapabilities;

const { ask: _ask, ...toolBeforeWithoutAsk } = capabilities.toolBefore.intercept;

/** What holds where pi has no UI (print mode): `ask` needs a person to answer it.
 * The permission events stay advertised, and are simply never raised: a registration
 * naming an unadvertised event is invalid (AHP registration), and the same
 * `hooks.json` must not turn a policy off because pi runs in print mode. */
export const withoutUI = {
  ...capabilities,
  toolBefore: { observe: true, intercept: toolBeforeWithoutAsk },
} satisfies HostCapabilities;

/** Coverage pi's extension API does not reach, as manifest gaps. */
export const gaps = [
  { path: "session.agent", reason: "pi has no subagents of its own: a child pi an extension starts reports as a session of its own, with no link to its parent" },
  { path: "turn.start.expansion", reason: "a prompt is refused or rewritten before skills and templates expand: the expanded text first appears at model.request.before" },
  { path: "turn.finish.before.modify", reason: "the answer is recorded and shown before the run settles: rewrite it at model.response.after" },
  { path: "model.request.before.params", reason: "AHP's modify targets messages: options are reported but not rewritten" },
  { path: "model.request.before.inject.history", reason: "context added to a request lasts for its turn: it is not written to the session" },
  { path: "model.request.before.housekeeping", reason: "compaction's and branch summaries' own requests are not reported" },
  { path: "model.request.before.tool_calls", reason: "calls already made stay in a rewritten request: a provider refuses calls and results that no longer pair" },
  { path: "turn.start.external", reason: "a refused message an extension sent has been saved by then: the model does not read it again in this runtime, but it stays in the session, and before pi 1.2 its text is not reported" },
  { path: "model.response.after.stream", reason: "a person has already seen the stream when a response is rewritten" },
  { path: "tool.before.return.nested", reason: "a call a codemode script makes has no result message to rewrite: return is not offered there" },
  { path: "tool.before.return.observers", reason: "a supplied result is a block rewritten afterwards: other extensions' tool_execution_end reports it as an error" },
  { path: "tool.before.modify.validation", reason: "pi validates arguments before tool_call and not after: a rewritten input is not checked again" },
  { path: "tool.after.flow.continue", reason: "pi has no continuation after a single tool result" },
  { path: "tool.after.mcp.thirdParty", reason: "only pi's built-in MCP tools are described as MCP: a tool an extension bridges from a server reports as native" },
  { path: "tool.permission.request.native", reason: "pi has no permission system: the stage exists only when a backend asks at tool.before" },
  { path: "tool.batch.after.nested", reason: "a batch lists the calls the model made, not those its codemode scripts made" },
  { path: "context.compact.after.removed", reason: "pi reports the first entry it kept, not the messages a compaction replaced" },
  { path: "config.change.before", reason: "pi raises no event before a setting changes" },
  { path: "config.change.after.settings", reason: "only the thinking level raises an event: settings files are not watched" },
  { path: "workspace.change", reason: "a pi session belongs to one directory: moving to another replaces the session, reported as session.end and session.start" },
  { path: "task.change", reason: "pi has no task list of its own" },
  { path: "user.elicitation", reason: "pi does not surface MCP elicitation to extensions" },
  { path: "user.message.outbound", reason: "pi has no channel for messages outside the conversation" },
  { path: "user.bash", reason: "a person's own !command is not an agent tool call, and AHP has no event for it" },
  { path: "file.changed.watcher", reason: "only the write and edit tools' changes are reported" },
  { path: "session.branch", reason: "/tree moves within a session and AHP has no event for it; /fork reports as a new session" },
];

/** The gaps where pi has no UI. */
export const gapsWithoutUI = [
  ...gaps,
  { path: "tool.before.ask", reason: "pi has no UI here, and no permission system of its own: nobody can answer" },
  { path: "tool.permission", reason: "the stage exists only for ask, so these events are not raised here" },
];
