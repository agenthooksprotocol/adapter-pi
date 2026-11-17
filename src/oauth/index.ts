// OAuth for the backends in hooks.json: delivery credentials through the SDK's
// managed OAuth, and the logins a person completes in a browser.
//
// Deliveries never create a login. They fail `interaction_required`, and the
// failure's diagnostic marks the backend; at the next turn the adapter prepares a
// login in the background and shows its link where only the person sees it (a
// widget and a notification, never the transcript). A pending login is stored and
// reused until it expires, so every turn shows the same link. `/ahp login`,
// `/ahp status` and `/ahp logout` are the explicit controls.
//
// Each backend has its own grants: the grant partition is the backend id, so one
// sign-in covers its event and upload endpoints, and no other backend's.
import { auth, AuthError, type DeliveryAuthFailure, type DeliveryAuthProvider } from "agenthooksprotocol/client";
import {
  bindingKey,
  frame,
  managedOAuth,
  type ClientConfig,
  type Operation,
  type PendingLogin,
  type StoredRecord,
} from "agenthooksprotocol/oauth";
import { join } from "node:path";
import { receive } from "./callback.js";
import { networkPolicy } from "./network.js";
import { backendAuth, type BackendAuth, type Endpoint } from "./settings.js";
import { FileSecrets, FileTokenStore } from "./store.js";

export const NAMESPACE = "dev.pi";
const SOFTWARE_ID = "@agenthooksprotocol/adapter-pi";
const DELIVERY_BUDGET_MS = 60_000;
const PREPARE_BUDGET_MS = 60_000;
const POLL_MS = 250;

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

function budget(ms: number, signal?: AbortSignal): Operation {
  return { signal: signal ?? new AbortController().signal, deadline: Date.now() + ms };
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
  readonly #pending = new Map<string, PendingLogin>();
  readonly #preparing = new Set<string>();
  readonly #told = new Set<string>();

  constructor(readonly host: LoginHost, agentDir: string, backends: readonly Record<string, unknown>[]) {
    this.store = new FileTokenStore(join(agentDir, "ahp-auth.json"));
    this.secrets = new FileSecrets(join(agentDir, "ahp-secrets.json"));
    for (const raw of backends) {
      const { auth: backend, problems } = backendAuth(raw);
      this.problems.push(...problems);
      const network = networkPolicy(backend.settings.allowPrivateNetwork);
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
    };
    this.provider = auth.compose({
      bearer: auth.bearer({ resolveCredentialReference: (reference, context) => this.secrets.get(reference, context.signal ?? new AbortController().signal) }),
      oauth,
      discover: oauth,
    });
  }

  /** Local trust: the issuer, client and scopes this backend may use. An issuer's
   * advertisement alone is trusted only for a browser login, where the person
   * sees where they sign in, and only when it is the one advertised. */
  async #select(backend: BackendAuth, issuers: readonly string[], resource: string, binding: Record<string, unknown> | undefined, operation: Operation): Promise<ClientConfig> {
    operation.signal.throwIfAborted();
    const { settings } = backend;
    const preset = binding?.type === "oauth" ? binding : undefined;
    const flow = settings.flow ?? (preset?.flow as ClientConfig["flow"] | undefined) ?? "authorization_code_pkce";
    const trusted = settings.issuer ?? (preset?.issuer as string | undefined);
    const issuer = trusted ?? (flow === "authorization_code_pkce" && issuers.length === 1 ? issuers[0] : undefined);
    if (!issuer || !issuers.includes(issuer)) throw new AuthError("access_denied");
    const clientId = settings.clientId ?? (preset?.clientId as string | undefined);
    const secretRef = settings.clientSecretRef ?? (preset?.clientSecretRef as string | undefined);
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
      ...(flow === "authorization_code_pkce" ? { redirectUri: backend.redirectUri } : {}),
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
      this.#needed.set(backendId, failure.requiredScopes);
      this.#failing.delete(backendId);
    } else {
      this.#failing.set(backendId, failure.code);
    }
  }

  /** A turn starts: prepare, in the background, each login a delivery asked for. */
  turnStart(): void {
    for (const id of this.#needed.keys()) {
      if (this.#preparing.has(id)) continue;
      if (!this.host.hasUI) {
        // No one to show a link to, and nothing listening once this run ends.
        if (!this.#told.has(id)) this.host.notify(`Agent Hooks Protocol: ${id} needs a sign-in; run /ahp login ${id} in an interactive pi.`, "warning");
        this.#told.add(id);
        continue;
      }
      this.#preparing.add(id);
      void this.#hint(id).finally(() => this.#preparing.delete(id));
    }
  }

  async #hint(id: string): Promise<void> {
    const backend = this.#backends.get(id)!;
    // The stored login this process already shows: nothing to prepare.
    const shown = this.#pending.get(id);
    if (shown && shown.expiresAt > Date.now() && (await this.#stillPending(backend, shown))) return;
    const result = await this.#prepare(backend);
    if (typeof result === "string") this.host.log(`${id}: sign-in not prepared: ${result}`);
  }

  /** Host prepare: ready, a pending login (shown and received), or a failure code. */
  async #prepare(backend: Backend): Promise<"ready" | PendingLogin | string> {
    const endpoint = backend.endpoints[0];
    if (!endpoint) return "unsupported_binding";
    const requiredScopes = this.#needed.get(backend.id);
    try {
      const result = await backend.oauth.prepare(this.#context(backend, endpoint), budget(PREPARE_BUDGET_MS), requiredScopes ? { requiredScopes } : {});
      if (result.type === "ready") {
        this.#done(backend.id);
        return "ready";
      }
      await this.#show(backend, result);
      return result;
    } catch (error) {
      const failure = code(error);
      this.#needed.delete(backend.id);
      this.#failing.set(backend.id, failure);
      return failure;
    }
  }

  #context(backend: BackendAuth, endpoint: Endpoint) {
    return { backendId: backend.id, purpose: endpoint.purpose, url: endpoint.url, ...(endpoint.authentication ? { authentication: endpoint.authentication as never } : {}) };
  }

  #pendingKey(backend: BackendAuth, endpoint: Endpoint): string {
    return frame("ahp.oauth.pending:", [bindingKey(NAMESPACE, this.#context(backend, endpoint))]);
  }

  async #load(key: string): Promise<StoredRecord | undefined> {
    return this.store.load(key, AbortSignal.timeout(10_000));
  }

  async #stillPending(backend: BackendAuth, login: PendingLogin): Promise<boolean> {
    const record = await this.#load(login.key).catch(() => undefined);
    return record?.kind === "pending_login" && record.id === login.id && record.expiresAt > Date.now();
  }

  /** Listen for the login's whole lifetime, and show its link. */
  async #show(backend: Backend, login: PendingLogin): Promise<void> {
    const previous = this.#pending.get(backend.id);
    this.#pending.set(backend.id, login);
    await receive(backend.settings.redirectPort, login.expiresAt + 5_000, backend.id, (callback) => this.#callback(backend, callback))
      .catch((error) => this.host.log(`${backend.id}: no callback listener: ${String(error)}`));
    this.#render();
    if (previous?.authorizationUrl !== login.authorizationUrl) this.host.notify(`Sign in to ${backend.id}: ${login.authorizationUrl}`);
  }

  /** A redirect reached the listener: complete the login it belongs to. */
  async #callback(backend: Backend, callback: string): Promise<{ ok: boolean; message: string } | undefined> {
    const endpoint = backend.endpoints[0];
    if (!endpoint) return undefined;
    const key = this.#pendingKey(backend, endpoint);
    const record = await this.#load(key);
    if (record?.kind !== "pending_login" || new URL(callback).searchParams.get("state") !== record.state) return undefined;
    const login: PendingLogin = { type: "pending_login", authorizationUrl: record.authorizationUrl, expiresAt: record.expiresAt, key, id: record.id };
    return this.#complete(backend, login, callback);
  }

  async #complete(backend: Backend, login: PendingLogin, callback: string): Promise<{ ok: boolean; message: string }> {
    try {
      await backend.oauth.complete(login, callback, budget(PREPARE_BUDGET_MS));
      this.#done(backend.id);
      this.host.notify(`Signed in to ${backend.id}.`);
      return { ok: true, message: `Signed in to ${backend.id}. You can close this tab.` };
    } catch (error) {
      const failure = code(error);
      this.host.notify(`Sign-in to ${backend.id} failed: ${failure}.`, "warning");
      return { ok: false, message: `Sign-in to ${backend.id} failed (${failure}). Run /ahp login ${backend.id} in pi to try again.` };
    }
  }

  #done(id: string): void {
    this.#needed.delete(id);
    this.#failing.delete(id);
    this.#told.delete(id);
    if (this.#pending.delete(id)) this.#render();
  }

  #render(): void {
    const now = Date.now();
    const lines = [...this.#pending].filter(([, login]) => login.expiresAt > now).map(([id, login]) => `Sign in to ${id}: ${login.authorizationUrl}`);
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
    const binding = await this.#load(bindingKey(NAMESPACE, this.#context(backend, endpoint))).catch(() => undefined);
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
    const result = await this.#prepare(backend);
    if (result === "ready") {
      const flow = backend.settings.flow ?? backend.preset?.flow;
      return flow === "client_credentials" ? "client-credentials" : "authorized";
    }
    if (typeof result === "string") return `failing: ${failing ?? result}${hint(result)}`;
    return `needs-login: ${result.authorizationUrl}`;
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
      const result = await this.#prepare(backend);
      if (result === "ready") {
        if (target) this.host.notify(`${backend.id} is already signed in. /ahp logout ${backend.id} first to sign in as someone else.`);
        continue;
      }
      if (typeof result === "string") {
        this.host.notify(`${backend.id} cannot sign in: ${result}${hint(result)}`, "warning");
        continue;
      }
      walked++;
      await this.#signIn(backend, result);
    }
    if (!target && walked === 0) this.host.notify("No backend needs a sign-in.");
  }

  /** Open the browser and wait for the redirect, or for a pasted one. */
  async #signIn(backend: Backend, login: PendingLogin): Promise<void> {
    this.host.open(login.authorizationUrl);
    const stop = new AbortController();
    const received = this.#untilEnded(backend, login, stop.signal).then(() => ({ type: "received" as const }));
    const contenders: Promise<{ type: "received" } | { type: "pasted"; value: string | undefined }>[] = [received];
    if (this.host.hasUI) {
      contenders.push(this.host.input(`Sign in to ${backend.id}`, "If the browser cannot reach pi, paste the address it ended on", stop.signal).then((value) => ({ type: "pasted" as const, value })));
    } else {
      console.error(`Sign in to ${backend.id}: ${login.authorizationUrl}`);
    }
    const first = await Promise.race(contenders);
    stop.abort();
    await received.catch(() => {});
    if (first.type === "pasted") {
      if (first.value?.trim()) await this.#complete(backend, login, first.value.trim());
      return;
    }
    // Completed here or by another pi, cancelled, or expired.
    if (this.#pending.get(backend.id)?.id === login.id) {
      const result = await this.#prepare(backend);
      if (result !== "ready") this.host.notify(`Sign-in to ${backend.id} did not complete.`, "warning");
      else this.host.notify(`Signed in to ${backend.id}.`);
    }
  }

  async #untilEnded(backend: BackendAuth, login: PendingLogin, signal: AbortSignal): Promise<void> {
    while (!signal.aborted && (await this.#stillPending(backend, login))) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }

  async #logout(id: string): Promise<void> {
    const backend = this.#backends.get(id)!;
    const signal = AbortSignal.timeout(30_000);
    for (const endpoint of backend.endpoints) {
      const key = this.#pendingKey(backend, endpoint);
      const pending = await this.store.load(key, signal);
      if (pending?.kind === "pending_login") {
        await backend.oauth.cancel({ type: "pending_login", authorizationUrl: pending.authorizationUrl, expiresAt: pending.expiresAt, key, id: pending.id }, budget(30_000));
      }
      const binding = await this.store.load(bindingKey(NAMESPACE, this.#context(backend, endpoint)), signal);
      const grantKey = binding?.kind === "binding" ? binding.grantKey : undefined;
      if (!grantKey) continue;
      await this.store.coordinate(grantKey, signal, async () => {
        const grant = await this.store.load(grantKey, signal);
        if (grant) await this.store.compareAndSet(grantKey, grant.generation, undefined, signal);
      });
    }
    this.#done(id);
    this.host.notify(`Signed out of ${id}.`);
  }
}

function hint(failure: string): string {
  if (failure === "credential_unavailable") return " (no client: set oauth.clientId, oauth.clientMetadataDocument, or oauth.issuer with oauth.registration in hooks.json)";
  if (failure === "access_denied") return " (the issuer is not trusted: set oauth.issuer in hooks.json)";
  if (failure === "untrusted_destination") return " (a private address: set oauth.allowPrivateNetwork in hooks.json)";
  return "";
}
