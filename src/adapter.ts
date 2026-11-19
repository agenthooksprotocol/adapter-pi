// The adapter's state and the plumbing every mapping shares. pi makes one
// extension instance per session runtime, replaced on /new, /resume, /fork and
// /reload, so one instance holds one session and one `Hooks` client.
//
// pi runs extensions in-process on Node with its whole runtime, so the SDK's own
// fetch, stdio and environment access apply: nothing here is shimmed.
import { VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Hooks } from "agenthooksprotocol/client";
import { capabilities, gaps, gapsWithoutUI, MAX_CONTINUATIONS, withoutUI } from "./capabilities.js";
import { agentDir, loadMcpServers, loadRegistration, projectDecided } from "./config.js";
import { Logins, type LoginHost } from "./oauth/index.js";
import { describe, messages, type AnyResult } from "./effects.js";

export const SOURCE = "urn:pi:coding-agent";
export const EXTENSION = "dev.pi";
/** The custom message type this adapter's context travels under. */
export const CUSTOM_TYPE = "agent-hooks-protocol";

const LOGIN_WIDGET = "agent-hooks-protocol-login";

/** The entries of `list` not in `seen`, now marked seen. Hooks appends to its
 * diagnostics and drops old ones, so position is no cursor: identity is. */
export function unseen<T extends object>(list: readonly T[], seen: WeakSet<object>): T[] {
  const fresh = list.filter((entry) => !seen.has(entry));
  for (const entry of fresh) seen.add(entry);
  return fresh;
}

/** The command that opens a link: $BROWSER (empty or "none" for none), or the platform's. */
function browser(): string[] {
  const chosen = process.env.BROWSER;
  if (chosen !== undefined) return chosen === "none" ? [] : chosen.split(" ").filter(Boolean);
  if (process.platform === "darwin") return ["open"];
  if (process.platform === "win32") return ["rundll32", "url.dll,FileProtocolHandler"];
  return ["xdg-open"];
}

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
  /** OAuth for the registration's backends; undefined without a registration. */
  logins: Logins | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  /** Initialization diagnostics already read. */
  readonly #seen = new WeakSet<object>();

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
      const dir = agentDir(process.env);
      if (dir) {
        this.logins = new Logins(this.#loginHost(), dir, registration.hooks);
        for (const line of this.logins.problems) this.warn(`Agent Hooks Protocol: ${line}`);
      }
      const hooks = await this.#client(registration);
      this.hooks = hooks;
      this.initialization(true);
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
        ...(this.logins ? { auth: this.logins.provider } : {}),
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

  /** Configuration discovery's diagnostics not read yet. Hooks adds them as it
   * retries a skipped backend (whose refusal no delivery would report), so they
   * are read at startup, each turn and each /ahp. */
  initialization(startup = false): void {
    for (const issue of unseen(this.hooks?.initializationDiagnostics ?? [], this.#seen)) {
      this.logins?.observe(issue.backendId, issue.authError && issue.recovery ? { code: issue.authError, recovery: issue.recovery, ...(issue.requiredScopes ? { requiredScopes: issue.requiredScopes } : {}) } : undefined);
      // A login is shown at the next turn, not here: startup never waits on a person.
      const line = `${issue.backendId}: ${issue.code}${issue.authError ? ` (${issue.authError})` : ""}`;
      if (issue.recovery === "login") this.log(`${issue.backendId}: ${issue.code}: needs a sign-in`);
      else if (startup) this.warn(`Agent Hooks Protocol: ${line}`);
      else this.log(line);
    }
  }

  /** Delivery diagnostics, and the messages a backend has for a person. */
  report(result: AnyResult): void {
    // The adapter reads no attachment back: release what the SDK kept.
    void result.content?.close().catch(() => {});
    for (const diagnostic of result.diagnostics) {
      this.logins?.observe(diagnostic.backendId, diagnostic.auth);
      const line = `${diagnostic.backendId} ${diagnostic.phase}: ${diagnostic.code}${diagnostic.auth ? ` (${diagnostic.auth.code})` : ""}`;
      if (diagnostic.syntheticDenial) this.warn(`${line} (denied by failure policy)`);
      else this.log(line);
    }
    for (const text of messages(result)) this.notify(text);
  }

  /** Show a person something: a notification, or stderr where pi has no UI. */
  notify(text: string, level: "info" | "warning" | "error" = "info"): void {
    try {
      if (this.ctx?.hasUI) return this.ctx.ui.notify(text, level);
    } catch {
      // A context of a session pi has replaced.
    }
    console.error(text);
  }

  /** Where a sign-in link may appear: pi's own UI, never the transcript. */
  #loginHost(): LoginHost {
    const adapter = this;
    return {
      get hasUI() {
        return adapter.ctx?.hasUI ?? false;
      },
      notify: (text, level) => adapter.notify(text, level),
      widget: (lines) => {
        if (adapter.ctx?.hasUI) adapter.ctx.ui.setWidget(LOGIN_WIDGET, lines);
      },
      input: (title, placeholder, signal) => (adapter.ctx?.hasUI ? adapter.ctx.ui.input(title, placeholder, { signal }) : Promise.resolve(undefined)),
      open: (url) => {
        if (!adapter.ctx?.hasUI) return;
        const [command, ...args] = browser();
        if (command) adapter.pi.exec(command, [...args, url]).catch(() => {});
      },
      log: (text) => adapter.log(text),
    };
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
    await this.logins?.close();
    await this.flush();
    const hooks = this.hooks;
    this.hooks = undefined;
    await hooks?.close();
  }
}
