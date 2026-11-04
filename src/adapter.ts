// The adapter's state and the plumbing every mapping shares. pi makes one
// extension instance per session runtime, replaced on /new, /resume, /fork and
// /reload, so one instance holds one session and one `Hooks` client.
//
// pi runs extensions in-process on Node with its whole runtime, so the SDK's own
// fetch, stdio and environment access apply: nothing here is shimmed.
import { VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Hooks } from "agenthooksprotocol/client";
import { capabilities, gaps, gapsWithoutUI, MAX_CONTINUATIONS, withoutUI } from "./capabilities.js";
import { loadMcpServers, loadRegistration, projectDecided } from "./config.js";
import { describe, messages, type AnyResult } from "./effects.js";

export const SOURCE = "urn:pi:coding-agent";
export const EXTENSION = "dev.pi";
/** The custom message type this adapter's context travels under. */
export const CUSTOM_TYPE = "agent-hooks-protocol";

const contentCategories = ["text", "reasoning", "instructions", "attachment", "summary", "system", "tool_call", "tool_result"];

type Registration = { protocolVersion: "draft"; hooks: Record<string, unknown>[] };

export interface Turn {
  /** pi has no turn identity: this one is the adapter's. */
  id: string;
  continuationCount: number;
  /** Model requests made so far. */
  requests: number;
  /** Consecutive failed requests: the next is another attempt at the same one. */
  failures: number;
  /** before_agent_start has run for it. */
  began: boolean;
  /** Context for the next before_agent_start. */
  pending: string[];
  /** Context for each of the turn's remaining requests. */
  context: string[];
  /** The system prompt a backend chose for the request being built. */
  system?: string;
  /** The last answer the model gave. */
  answer?: { id: string; text: string };
  error?: { class: string; message: string };
  cancelled?: boolean;
  /** A backend refused the request being built: the abort that follows is its own. */
  refused?: boolean;
}

/** What the adapter remembers about a tool call between its events. */
export interface CallState {
  id: string;
  name: string;
  input: Record<string, unknown>;
  beforeEventId?: string;
  /** tool.before's context, added to the result. */
  context: string[];
  /** tool.after has been delivered. */
  afterSent?: boolean;
  /** The result a backend supplied: the block's message becomes this. */
  supplied?: string;
  /** Whether the file a write will touch already exists. */
  existed?: boolean;
}

export class Adapter {
  hooks: Hooks | undefined;
  ctx!: ExtensionContext;
  sessionId = "";
  cwd = "";
  model: { id: string; provider: string } | undefined;
  turn: Turn | undefined;
  /** A dialog of the adapter's own is open. */
  asking = false;
  /** The model is being set back: its event is not a new switch. */
  reverting = false;
  /** A backend refused the compaction: pi's failure event is that refusal. */
  compactionRefused = false;
  /** Extension messages a backend refused after pi had saved them. */
  readonly refusedMessages = new Set<string>();
  readonly calls = new Map<string, CallState>();
  /** How each call of the current model request resolved, for its batch. */
  resolved = new Map<string, { outcome: "ok" | "error" | "denied" | "cancelled"; execution: { status: "executed" } | { status: "skipped"; reason: "policy" | "cancelled" | "supplied_result" | "other"; detail?: string } }>();
  mcp = new Map<string, Record<string, unknown>>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(readonly pi: ExtensionAPI) {}

  /** Discovery may wait on backends: session_start is awaited, so no prompt
   * overtakes it. A registration that does not start leaves pi working as it was. */
  async start(ctx: ExtensionContext): Promise<void> {
    this.ctx = ctx;
    if (Number.parseInt(VERSION, 10) < 1) this.warn(`Agent Hooks Protocol needs pi 1.0 or later; this is ${VERSION}. Some boundaries will not fire.`);
    this.sessionId = ctx.sessionManager.getSessionId();
    this.cwd = ctx.cwd;
    this.model = ctx.model ? { id: ctx.model.id, provider: ctx.model.provider } : undefined;
    try {
      this.mcp = loadMcpServers(process.env, ctx.cwd, ctx.isProjectTrusted());
      const decided = projectDecided({
        environment: process.env,
        cwd: ctx.cwd,
        trusted: ctx.isProjectTrusted(),
        argv: process.argv,
        defaultProjectTrust: this.pi.getSettings().defaultProjectTrust,
      });
      const { registration, sources, diagnostics, notes, untrusted } = loadRegistration(process.env, ctx.cwd, decided);
      for (const line of diagnostics) this.warn(`Agent Hooks Protocol: ${line}`);
      for (const line of notes) this.log(line);
      if (untrusted.length) this.warn(`Agent Hooks Protocol ignored ${untrusted.join(", ")}: trust this project with /trust or --approve to use it.`);
      if (!registration) return;
      const hooks = await this.#client(registration);
      for (const issue of hooks.initializationDiagnostics ?? []) this.warn(`Agent Hooks Protocol: ${issue.backendId}: ${issue.code}`);
      this.hooks = hooks;
      this.log(`delivering to ${registration.hooks.length} backend(s) from ${sources.map((source) => source.path).join(", ")}`);
    } catch (error) {
      this.hooks = undefined;
      this.warn(`Agent Hooks Protocol not started: ${describe(error)}`);
    }
  }

  /** One client for every backend that is valid: one that is not must not take a
   * valid backend's fail-closed policy down with it. */
  async #client(registration: Registration): Promise<Hooks> {
    const create = async (hooks: Record<string, unknown>[]) => {
      const client = new Hooks({ ...registration, hooks }, {
        source: SOURCE,
        harness: { name: "pi", version: VERSION },
        capabilities: this.ctx.hasUI ? capabilities : withoutUI,
        manifestMetadata: {
          authentication: ["bearer", "oauth"],
          contentCategories,
          correlationIdentityFields: ["session.id", "turn.id", "call.id", "parentEventId"],
          gaps: this.ctx.hasUI ? gaps : gapsWithoutUI,
          limits: { maxContinuations: MAX_CONTINUATIONS },
          managedPolicy: { disableable: true, scopes: ["user", "project"] },
          toolPaths: ["native", "mcp"],
          transports: ["http", "stdio"],
        },
      });
      await client.initialized;
      return client;
    };
    try {
      return await create(registration.hooks);
    } catch (error) {
      if (registration.hooks.length < 2) throw error;
    }
    const usable: Record<string, unknown>[] = [];
    for (const backend of registration.hooks) {
      try {
        await (await create([backend])).close();
        usable.push(backend);
      } catch (error) {
        this.warn(`Agent Hooks Protocol: backend ${String(backend.id)} is invalid and was skipped: ${describe(error)}`);
      }
    }
    return create(usable);
  }

  /** The client; undefined when nothing subscribes to `type`. */
  client(type: string): Hooks | undefined {
    const hooks = this.hooks;
    if (!hooks || !hooks.subscribes(type as never)) return undefined;
    return hooks;
  }

  /** The AHP session object. */
  sessionObject() {
    return {
      id: this.sessionId,
      cwd: this.cwd,
      ...(this.model ? { model: `${this.model.provider}/${this.model.id}` } : {}),
    };
  }

  turnObject(turn: Turn) {
    return { id: turn.id, synthesized: true };
  }

  /** Session and turn for an event raised in the session. */
  scope() {
    return {
      session: this.sessionObject(),
      ...(this.turn ? { turn: this.turnObject(this.turn) } : {}),
    };
  }

  /** Streaming events are not awaited by anything worth holding up: they go in
   * order here, and every other delivery waits for them first. */
  enqueue(work: () => Promise<unknown>): void {
    this.#queue = this.#queue.then(work).catch((error) => this.log(`event failed: ${describe(error)}`));
  }

  flush(): Promise<unknown> {
    return this.#queue;
  }

  /** Delivery diagnostics, and the messages a backend has for a person. */
  report(result: AnyResult): void {
    // The adapter reads no attachment back: release what the SDK kept.
    void result.content?.close().catch(() => {});
    for (const diagnostic of result.diagnostics) {
      const line = `${diagnostic.backendId} ${diagnostic.phase}: ${diagnostic.code}`;
      if (diagnostic.syntheticDenial) this.warn(`${line} (denied by failure policy)`);
      else this.log(line);
    }
    for (const text of messages(result)) this.notify(text);
  }

  /** Show a person something: a notification, or stderr where pi has no UI. */
  notify(text: string, level: "info" | "warning" | "error" = "info"): void {
    if (this.ctx?.hasUI) this.ctx.ui.notify(text, level);
    else console.error(text);
  }

  warn(text: string): void {
    this.notify(text, "warning");
  }

  /** Detail nobody needs while things work. */
  log(text: string): void {
    if (process.env.AHP_DEBUG) console.error(`[agent-hooks-protocol] ${text}`);
  }

  /** Context the model reads from here on. */
  customMessage(text: string) {
    return { customType: CUSTOM_TYPE, content: text, display: false };
  }

  async close(): Promise<void> {
    await this.flush();
    const hooks = this.hooks;
    this.hooks = undefined;
    await hooks?.close();
  }
}
