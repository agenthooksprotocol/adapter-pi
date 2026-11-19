// OAuth for the backends in hooks.json: delivery credentials through the SDK's
// managed OAuth, and the logins a person completes in a browser.
//
// Deliveries never create a login. They fail `interaction_required`, and the
// failure's diagnostic marks the backend; at the next turn the adapter prepares a
// login in the background and shows its link where only the person sees it (a
// widget and a notification, never the transcript). `/ahp login`, `/ahp status`
// and `/ahp logout` are the explicit controls.
//
// As in MCP clients, a login belongs to the pi that prepared it: it listens on a
// port of its own for the redirect, keeps showing the same link until the login
// ends, and completes it. Grants are shared through the store, so every pi uses
// the newest sign-in, and drops its own link once it sees one.
//
// Each backend has its own grants: the grant partition is the backend id, so one
// sign-in covers its event and upload endpoints, and no other backend's.
import { auth, AuthError, type DeliveryAuthContext, type DeliveryAuthFailure, type DeliveryAuthProvider } from "agenthooksprotocol/client";
import { bindingKey, managedOAuth, type ClientConfig, type Operation, type PendingLogin, type StoredRecord } from "agenthooksprotocol/oauth";
import { join } from "node:path";
import { receive, type Receiver } from "./callback.js";
import { networkPolicy, type NetworkPolicy } from "./network.js";
import { backendAuth, trustedIssuer, type BackendAuth, type Endpoint } from "./settings.js";
import { FileSecrets, FileTokenStore } from "./store.js";

export const NAMESPACE = "dev.pi";
const SOFTWARE_ID = "@agenthooksprotocol/adapter-pi";
const DELIVERY_BUDGET_MS = 60_000;
const PREPARE_BUDGET_MS = 60_000;

/** What the logins need from pi. Every call reads the latest session context. */
export interface LoginHost {
  readonly hasUI: boolean;
  notify(text: string, level?: "info" | "warning" | "error"): void;
  /** Lines shown above the editor; undefined clears them. */
  widget(lines: string[] | undefined): void;
  /** A text box; resolves undefined when dismissed or `signal` aborts. */
  input(title: string, placeholder: string, signal: AbortSignal): Promise<string | undefined>;
  open(url: string): void;
  log(text: string): void;
}

type Managed = ReturnType<typeof managedOAuth>;

interface Backend extends BackendAuth {
  oauth: Managed;
}

/** A login this pi prepared, and the listener for its redirect. */
interface Active {
  login: PendingLogin;
  receiver: Receiver;
  /** Scopes it was prepared for: a grant from elsewhere must cover them. */
  required: readonly string[];
  /** The grant when it was prepared: a newer one means someone signed in. */
  grant: { key: string; record: StoredRecord | undefined } | undefined;
  expiry?: ReturnType<typeof setTimeout>;
  /** `/ahp login` waiting for the login to end. */
  waiters: (() => void)[];
  /** Set once the login has ended: nothing waits on it after that. */
  ended?: boolean;
}

/** Where OAuth requests may go; tests substitute their own. */
export interface LoginOptions {
  network?: (allowPrivateNetwork: boolean) => NetworkPolicy;
}

function budget(ms: number, signal?: AbortSignal): Operation {
  return { signal: signal ?? new AbortController().signal, deadline: Date.now() + ms };
}

/** Whether `value` is an address on this redirect: the one a browser ends on. */
function onRedirect(value: string, redirectUri: string): boolean {
  try {
    const actual = new URL(value), expected = new URL(redirectUri);
    return actual.origin === expected.origin && actual.pathname === expected.pathname;
  } catch {
    return false;
  }
}

function stateOf(callback: string): string | null {
  try {
    return new URL(callback).searchParams.get("state");
  } catch {
    return null;
  }
}

function code(error: unknown): string {
  return error instanceof AuthError ? error.code : error instanceof Error && error.name === "TimeoutError" ? "timeout" : "provider_failed";
}

export class Logins {
  readonly store: FileTokenStore;
  readonly secrets: FileSecrets;
  readonly provider: DeliveryAuthProvider;
  readonly problems: string[] = [];
  readonly #backends = new Map<string, Backend>();
  /** Backends whose last delivery needs a login, with the scopes it needed. */
  readonly #needed = new Map<string, readonly string[] | undefined>();
  /** The last authentication failure that a login will not fix. */
  readonly #failing = new Map<string, string>();
  readonly #active = new Map<string, Active>();
  readonly #ensuring = new Map<string, Promise<"ready" | Active | string>>();
  readonly #told = new Set<string>();
  /** Scopes a login was refused for: outside what this backend may have. */
  readonly #outside = new Map<string, readonly string[]>();

  constructor(readonly host: LoginHost, agentDir: string, backends: readonly Record<string, unknown>[], options: LoginOptions = {}) {
    this.store = new FileTokenStore(join(agentDir, "ahp-auth.json"));
    this.secrets = new FileSecrets(join(agentDir, "ahp-secrets.json"));
    // Earlier versions kept pending logins, PKCE verifiers included, in the store.
    void this.store.dropExpiredLogins(AbortSignal.timeout(30_000)).catch(() => {});
    for (const raw of backends) {
      const { auth: backend, problems } = backendAuth(raw);
      this.problems.push(...problems);
      const network = (options.network ?? networkPolicy)(backend.settings.allowPrivateNetwork);
      const oauth = managedOAuth({
        namespace: NAMESPACE,
        store: this.store,
        secrets: this.secrets,
        policyFetch: network.policyFetch,
        checkDestination: network.checkDestination,
        loginLifetimeMs: backend.settings.loginLifetimeMs,
        selectClient: (issuers, resource, context, operation) => this.#select(backend, issuers, resource, context.authentication as Record<string, unknown> | undefined, operation),
      });
      this.#backends.set(backend.id, { ...backend, oauth });
    }
    const providers = new Map([...this.#backends].map(([id, backend]) => [id, backend.oauth.provider({ budget: (context) => budget(DELIVERY_BUDGET_MS, context.signal) })]));
    const route = (id: string) => {
      const provider = providers.get(id);
      if (!provider) throw new AuthError("invalid_configuration");
      return provider;
    };
    const oauth: DeliveryAuthProvider = {
      credential: (context) => route(context.backendId).credential(context),
      challenge: (context) => route(context.backendId).challenge(context),
      // A sign-in lets Hooks retry a backend whose configuration discovery it skipped.
      onPrepared: (listener) => {
        const stops = [...providers.values()].map((provider) => provider.onPrepared!(listener));
        return () => stops.forEach((stop) => stop());
      },
    };
    this.provider = auth.compose({
      bearer: auth.bearer({ resolveCredentialReference: (reference, context) => this.secrets.get(reference, context.signal ?? new AbortController().signal) }),
      oauth,
      discover: oauth,
    });
  }

  /** Local trust: the issuer, client and scopes this backend may use. */
  async #select(backend: BackendAuth, issuers: readonly string[], resource: string, binding: Record<string, unknown> | undefined, operation: Operation): Promise<ClientConfig> {
    operation.signal.throwIfAborted();
    const { settings } = backend;
    const preset = binding?.type === "oauth" ? binding : undefined;
    const flow = settings.flow ?? (preset?.flow as ClientConfig["flow"] | undefined) ?? "authorization_code_pkce";
    const clientId = settings.clientId ?? (preset?.clientId as string | undefined);
    const secretRef = settings.clientSecretRef ?? (preset?.clientSecretRef as string | undefined);
    const issuer = trustedIssuer({
      configured: settings.issuer ?? (preset?.issuer as string | undefined),
      trustAdvertised: settings.trustAdvertisedIssuer,
      flow,
      confidential: secretRef !== undefined || flow === "client_credentials",
      advertised: issuers,
    });
    if (!issuer) throw new AuthError("access_denied");
    let clientSecret: string | undefined;
    if (secretRef !== undefined) {
      clientSecret = await this.secrets.get(secretRef, operation.signal);
      if (clientSecret === undefined) throw new AuthError("credential_unavailable");
    }
    const scopes = settings.scopes ?? (Array.isArray(preset?.scopes) ? (preset.scopes as string[]) : []);
    return {
      issuer,
      resource,
      flow,
      scopes,
      grantPartition: backend.id,
      ...(clientId !== undefined ? { clientId } : {}),
      ...(clientSecret !== undefined ? { clientSecret } : {}),
      ...(settings.clientMetadataDocument ? { clientMetadataDocument: settings.clientMetadataDocument } : {}),
      ...(settings.registration && issuer === settings.issuer
        ? { registration: { clientName: "pi (Agent Hooks Protocol)", softwareId: SOFTWARE_ID, ...settings.registration } }
        : {}),
    };
  }

  ids(): string[] {
    return [...this.#backends.keys()];
  }

  /** A delivery's or initialization's authentication failure. */
  observe(backendId: string, failure: DeliveryAuthFailure | undefined): void {
    if (!failure || !this.#backends.has(backendId)) return;
    if (failure.recovery === "login") {
      if (!this.#needed.has(backendId)) this.#told.delete(backendId);
      // Step-up scopes stay needed until a grant covers them: a later failure that
      // names none does not drop them.
      const scopes = [...new Set([...(this.#needed.get(backendId) ?? []), ...(failure.requiredScopes ?? [])])];
      this.#needed.set(backendId, scopes.length ? scopes : undefined);
      this.#failing.delete(backendId);
    } else {
      this.#failing.set(backendId, failure.code);
    }
  }

  /** A turn starts: prepare, in the background, each login a delivery asked for,
   * and drop the links of logins another pi made unnecessary. */
  turnStart(): void {
    for (const id of new Set([...this.#needed.keys(), ...this.#active.keys()])) {
      if (!this.host.hasUI) {
        // No one to show a link to, and nothing listening once this run ends.
        if (!this.#told.has(id)) this.host.notify(`Agent Hooks Protocol: ${id} needs a sign-in; run /ahp login ${id} in an interactive pi.`, "warning");
        this.#told.add(id);
        continue;
      }
      void this.#ensure(this.#backends.get(id)!).then((result) => {
        if (typeof result === "string" && result !== "ready") this.host.log(`${id}: sign-in not prepared: ${result}`);
      });
    }
  }

  /** Signed in, this pi's own live login (prepared now if there is none), or a failure code. */
  #ensure(backend: Backend): Promise<"ready" | Active | string> {
    const running = this.#ensuring.get(backend.id);
    if (running) return running;
    const work = (async () => {
      const active = this.#active.get(backend.id);
      if (active) {
        // A login prepared before a delivery asked for more scopes cannot grant them.
        const covers = (this.#needed.get(backend.id) ?? []).every((scope) => active.required.includes(scope));
        if (covers && active.login.expiresAt > Date.now() && !(await this.#grantedElsewhere(active)) && this.#active.get(backend.id) === active) return active;
        await this.#end(backend, active);
      }
      return this.#prepare(backend);
    })().finally(() => this.#ensuring.delete(backend.id));
    this.#ensuring.set(backend.id, work);
    return work;
  }

  /** Host prepare, with a listener of its own for the login it may create. */
  async #prepare(backend: Backend): Promise<"ready" | Active | string> {
    const endpoint = backend.endpoints[0];
    if (!endpoint) return "unsupported_binding";
    const requiredScopes = this.#needed.get(backend.id);
    this.#outside.delete(backend.id);
    let receiver: Receiver | undefined;
    try {
      receiver = await receive((callback) => this.#complete(backend, callback));
      const context = this.#context(backend, endpoint);
      const result = await backend.oauth.prepare(context, budget(PREPARE_BUDGET_MS), { redirectUri: receiver.redirectUri, ...(requiredScopes ? { requiredScopes } : {}) });
      if (result.type === "ready") {
        receiver.close();
        this.#done(backend.id);
        return "ready";
      }
      receiver.state = result.state;
      const active: Active = { login: result, receiver, required: requiredScopes ?? [], grant: await this.#grant(context), waiters: [] };
      active.expiry = setTimeout(() => void this.#end(backend, active), Math.max(0, result.expiresAt - Date.now()));
      active.expiry.unref();
      this.#active.set(backend.id, active);
      this.#render();
      this.host.notify(`Sign in to ${backend.id}: ${result.authorizationUrl}`);
      return active;
    } catch (error) {
      receiver?.close();
      const failure = code(error);
      // Step-up scopes beyond the ceiling fail access_denied, naming them.
      if (error instanceof AuthError && error.code === "access_denied" && error.requiredScopes?.length) this.#outside.set(backend.id, error.requiredScopes);
      this.#needed.delete(backend.id);
      this.#failing.set(backend.id, failure);
      return failure;
    }
  }

  #context(backend: BackendAuth, endpoint: Endpoint) {
    return { backendId: backend.id, purpose: endpoint.purpose, url: endpoint.url, ...(endpoint.authentication ? { authentication: endpoint.authentication as never } : {}) };
  }

  /** The stored grant this endpoint's binding names, if any. */
  async #grant(context: DeliveryAuthContext): Promise<{ key: string; record: StoredRecord | undefined } | undefined> {
    const signal = AbortSignal.timeout(10_000);
    const binding = await this.store.load(bindingKey(NAMESPACE, context), signal).catch(() => undefined);
    const key = binding?.kind === "binding" ? binding.grantKey : undefined;
    return key ? { key, record: await this.store.load(key, signal).catch(() => undefined) } : undefined;
  }

  /** Another pi completed a sign-in since this login was prepared: the grant, shared
   * through the store, now has tokens covering what this login asked for. */
  async #grantedElsewhere(active: Active): Promise<boolean> {
    if (!active.grant) return false;
    const record = await this.store.load(active.grant.key, AbortSignal.timeout(10_000)).catch(() => undefined);
    if (record?.kind !== "grant" || record.generation === active.grant.record?.generation) return false;
    return (record.token !== undefined || record.refreshToken !== undefined) && active.required.every((scope) => record.scopes.includes(scope));
  }

  /** A redirect reached this login's listener, or was pasted into this pi. */
  async #complete(backend: Backend, callback: string): Promise<{ ok: boolean; message: string }> {
    try {
      await backend.oauth.complete(callback, budget(PREPARE_BUDGET_MS));
      this.#done(backend.id);
      this.host.notify(`Signed in to ${backend.id}.`);
      return { ok: true, message: `Signed in to ${backend.id}. You can close this tab.` };
    } catch (error) {
      const failure = code(error);
      const active = this.#active.get(backend.id);
      if (active && stateOf(callback) === active.login.state) {
        // A callback the SDK refused before using it (a wrong address, issuer or a
        // stray request) leaves the login waiting for the real one.
        if (await this.#live(backend, active)) {
          if (this.#active.get(backend.id) === active) active.receiver.state = active.login.state;
          this.host.notify(`Sign-in to ${backend.id} failed: ${failure}. Its link still works.`, "warning");
          return { ok: false, message: `This did not complete the sign-in to ${backend.id} (${failure}). The sign-in is still waiting in pi.` };
        }
        // A login the SDK used up has ended; the next turn or /ahp login makes another.
        await this.#end(backend, active);
      }
      this.host.notify(`Sign-in to ${backend.id} failed: ${failure}.`, "warning");
      return { ok: false, message: `Sign-in to ${backend.id} failed (${failure}). Run /ahp login ${backend.id} in pi to try again.` };
    }
  }

  /** Whether the SDK still holds this login. It refuses a callback on another
   * path before anything can consume the login, and fails interaction_required
   * only for one that has ended (used, cancelled or expired). */
  async #live(backend: Backend, active: Active): Promise<boolean> {
    if (active.login.expiresAt <= Date.now()) return false;
    const probe = new URL(active.receiver.redirectUri);
    probe.pathname += "/probe";
    probe.search = new URLSearchParams({ state: active.login.state }).toString();
    try {
      await backend.oauth.complete(probe.href, budget(10_000));
      return false;
    } catch (error) {
      return code(error) !== "interaction_required";
    }
  }

  /** End this pi's login: expired, failed, superseded or signed out. */
  async #end(backend: Backend, active: Active): Promise<void> {
    if (this.#active.get(backend.id) !== active) return;
    this.#active.delete(backend.id);
    this.#stop(active);
    this.#render();
    await backend.oauth.cancel(active.login, budget(10_000)).catch(() => {});
  }

  #stop(active: Active): void {
    active.ended = true;
    clearTimeout(active.expiry);
    active.receiver.close();
    for (const settle of active.waiters.splice(0)) settle();
  }

  #done(id: string): void {
    this.#needed.delete(id);
    this.#failing.delete(id);
    this.#told.delete(id);
    const active = this.#active.get(id);
    if (!active) return;
    this.#active.delete(id);
    this.#stop(active);
    this.#render();
  }

  #render(): void {
    const lines = [...this.#active].map(([id, active]) => `Sign in to ${id}: ${active.login.authorizationUrl}`);
    try {
      this.host.widget(lines.length ? lines : undefined);
    } catch {
      // The session this belonged to has been replaced.
    }
  }

  /** Whether OAuth has anything to say about this backend. */
  async #relevant(backend: BackendAuth): Promise<boolean> {
    const endpoint = backend.endpoints[0];
    if (!endpoint || backend.headerAuthorization || backend.preset?.type === "bearer") return false;
    if (backend.preset?.type === "oauth" || backend.configured || this.#needed.has(backend.id) || this.#failing.has(backend.id)) return true;
    const binding = await this.store.load(bindingKey(NAMESPACE, this.#context(backend, endpoint)), AbortSignal.timeout(10_000)).catch(() => undefined);
    return binding !== undefined;
  }

  /** `/ahp status|login|logout`. */
  async command(args: string): Promise<void> {
    const [verb = "status", target] = args.trim().split(/\s+/).filter(Boolean);
    if (target !== undefined && !this.#backends.has(target)) {
      this.host.notify(`No backend ${target}. Backends: ${this.ids().join(", ") || "none"}.`, "warning");
      return;
    }
    if (verb === "status") return this.#status(target);
    if (verb === "login") return this.#login(target);
    if (verb === "logout" && target) return this.#logout(target);
    this.host.notify("Usage: /ahp status | /ahp login [backend] | /ahp logout <backend>", "warning");
  }

  async #status(target: string | undefined): Promise<void> {
    const lines: string[] = [];
    for (const backend of this.#backends.values()) {
      if (target && backend.id !== target) continue;
      lines.push(`${backend.id}: ${await this.#describe(backend)}`);
    }
    this.host.notify(lines.join("\n") || "No backends.");
  }

  async #describe(backend: Backend): Promise<string> {
    if (!backend.endpoints.length) return "local process, no sign-in";
    if (backend.headerAuthorization) return "Authorization header from hooks.json";
    if (backend.preset?.type === "bearer") return "bearer token from hooks.json";
    if (!(await this.#relevant(backend))) return "no sign-in needed";
    const failing = this.#failing.get(backend.id);
    const result = await this.#ensure(backend);
    if (result === "ready") {
      const flow = backend.settings.flow ?? backend.preset?.flow;
      return flow === "client_credentials" ? "client-credentials" : "authorized";
    }
    if (typeof result === "string") return `failing: ${failing ?? result}${hint(result, this.#outside.get(backend.id))}`;
    return `needs-login: ${result.login.authorizationUrl}`;
  }

  async #login(target: string | undefined): Promise<void> {
    const backends = target ? [this.#backends.get(target)!] : [...this.#backends.values()];
    let walked = 0;
    for (const backend of backends) {
      if (!target && !(await this.#relevant(backend))) continue;
      if (!backend.endpoints.length) {
        this.host.notify(`${backend.id} is a local process: it has no sign-in.`, "warning");
        continue;
      }
      const result = await this.#ensure(backend);
      if (result === "ready") {
        if (target) this.host.notify(`${backend.id} is already signed in. /ahp logout ${backend.id} first to sign in as someone else.`);
        continue;
      }
      if (typeof result === "string") {
        this.host.notify(`${backend.id} cannot sign in: ${result}${hint(result, this.#outside.get(backend.id))}`, "warning");
        continue;
      }
      walked++;
      await this.#signIn(backend, result);
    }
    if (!target && walked === 0) this.host.notify("No backend needs a sign-in.");
  }

  /** Open the browser and wait for the redirect, or for a pasted one. */
  async #signIn(backend: Backend, active: Active): Promise<void> {
    // Ended since it was prepared: there is nothing to wait for.
    if (active.ended) return;
    this.host.open(active.login.authorizationUrl);
    const ended = new Promise<{ type: "ended" }>((resolve) => {
      if (active.ended) resolve({ type: "ended" });
      else active.waiters.push(() => resolve({ type: "ended" }));
    });
    // The listener never keeps pi alive by itself: while a person is asked to sign
    // in (`pi -p "/ahp login …"` too), this does, until the login ends.
    const hold = setTimeout(() => {}, Math.max(0, active.login.expiresAt - Date.now()));
    try {
      for (;;) {
        const stop = new AbortController();
        const contenders: Promise<{ type: "ended" } | { type: "pasted"; value: string | undefined }>[] = [ended];
        if (this.host.hasUI) {
          contenders.push(this.host.input(`Sign in to ${backend.id}`, "If the browser cannot reach pi, paste the address it ended on", stop.signal).then((value) => ({ type: "pasted" as const, value })));
        }
        const first = await Promise.race(contenders);
        stop.abort();
        const value = first.type === "pasted" ? first.value?.trim() : undefined;
        if (!value) return;
        // Not the redirect (the sign-in link itself, say): the login stays as it was.
        if (!onRedirect(value, active.receiver.redirectUri)) {
          this.host.notify(`That is not where the browser ended. Paste the address that starts with ${active.receiver.redirectUri}.`, "warning");
          continue;
        }
        // The paste completes here, in the pi that owns the login.
        const result = await this.#complete(backend, value);
        if (result.ok || active.ended) return;
      }
    } finally {
      clearTimeout(hold);
    }
  }

  /** The session ends (or pi replaces this instance): every login this pi shows
   * ends with it, so an old link can never sign anyone in. */
  async close(): Promise<void> {
    await Promise.all([...this.#active].map(([id, active]) => this.#end(this.#backends.get(id)!, active)));
  }

  async #logout(id: string): Promise<void> {
    const backend = this.#backends.get(id)!;
    const signal = AbortSignal.timeout(30_000);
    const active = this.#active.get(id);
    if (active) await this.#end(backend, active);
    for (const endpoint of backend.endpoints) {
      const grant = await this.#grant(this.#context(backend, endpoint));
      if (!grant) continue;
      await this.store.coordinate(grant.key, signal, async () => {
        const record = await this.store.load(grant.key, signal);
        if (record) await this.store.compareAndSet(grant.key, record.generation, undefined, signal);
      });
    }
    this.#done(id);
    this.host.notify(`Signed out of ${id}.`);
  }
}

function hint(failure: string, outside?: readonly string[]): string {
  if (failure === "credential_unavailable") return " (no client: set oauth.clientId, oauth.clientMetadataDocument, or oauth.issuer with oauth.registration in hooks.json)";
  if (failure === "access_denied" && outside?.length) return ` (it needs scopes this backend is not allowed: ${outside.join(" ")}; add them to oauth.scopes in hooks.json to allow them)`;
  if (failure === "access_denied") return " (the issuer is not trusted: set oauth.issuer, or oauth.trustAdvertisedIssuer for a browser sign-in, in hooks.json)";
  if (failure === "untrusted_destination") return " (a private address: set oauth.allowPrivateNetwork in hooks.json)";
  return "";
}
