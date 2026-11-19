// The adapter inside a real pi, on the oldest and newest versions it claims: RPC
// mode for what a person would do, an isolated home, a local fake model and a
// recording AHP backend. Nothing here reaches a real backend or provider.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "../..");
const root = realpathSync(mkdtempSync(join(tmpdir(), "ahp-pi-e2e-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The package as pi would install it: without a copy of pi beside it, so its
 * imports of pi resolve to the pi that loads it. */
const installed = join(root, "installed");
beforeAll(async () => {
  mkdirSync(installed, { recursive: true });
  const run = async (command: string[], cwd: string) => {
    const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
    const output = await new Response(child.stdout).text();
    if ((await child.exited) !== 0) throw new Error(`${command.join(" ")}: ${await new Response(child.stderr).text()}`);
    return output.trim();
  };
  const tarball = (await run(["npm", "pack", "--ignore-scripts", "--pack-destination", root], REPO)).split("\n").at(-1)!;
  await run(["tar", "xzf", join(root, tarball), "-C", installed, "--strip-components=1"], root);
  await run(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", "--omit=dev", "--omit=peer", "--legacy-peer-deps"], installed);
}, 120000);

type Event = Record<string, any> & { type: string };
type Options = { mcp?: boolean; codemode?: boolean; retry?: boolean };
type Request = { model: string; tools?: unknown[]; messages: { role: string; content: unknown; tool_calls?: unknown[] }[] };

const body = (text: string) => ({ kind: "text", mediaType: "text/plain", selection: "body", text });
const inject = (event: Event, text: string) => ({ type: "inject", target: "context", operation: "append", deliverAt: "now", value: [{ id: `i-${event.id}`, role: "user", parts: [{ id: `i-${event.id}#0`, ...body(text) }] }] });
const text = (content: unknown) => (typeof content === "string" ? content : ((content ?? []) as { text?: string }[]).map((part) => part.text ?? "").join("\n"));

const OBSERVE = ["session.end", "turn.end", "turn.progress", "model.error", "model.switch.after", "tool.progress", "tool.permission.resolved", "context.compact.after", "config.change.after", "file.changed", "user.attention"];
const INTERCEPT = ["session.start", "turn.start", "turn.finish.before", "model.request.before", "model.response.after", "model.switch.before", "tool.before", "tool.after", "tool.batch.after", "tool.permission.request", "context.compact.before", "user.message.inbound"];

/** One real pi and everything around it. */
class World {
  readonly received: Event[] = [];
  readonly requests: Request[] = [];
  readonly ui: Record<string, any>[] = [];
  /** What pi reported an extension's handler threw: always a bug here. */
  readonly errors: Record<string, any>[] = [];
  policy: (event: Event) => unknown[] = () => [];
  confirm = true;
  /** Requests that take this long, for what happens while one is running. */
  delayMs = 0;
  /** Deliveries of this type wait this long. */
  slow: { type: string; ms: number } | undefined;
  readonly uploads: { size: number; mediaType: string | null }[] = [];
  readonly responses: Record<string, any>[] = [];
  readonly dir: string;
  readonly home: string;
  readonly project: string;
  readonly agent: string;
  #backend: ReturnType<typeof Bun.serve>;
  #model: ReturnType<typeof Bun.serve>;
  #pi?: ReturnType<typeof Bun.spawn>;
  #stopped = false;
  failedOnce = false;

  constructor(readonly cli: string, options: Options = {}) {
    this.dir = mkdtempSync(join(root, "world-"));
    this.home = join(this.dir, "home");
    this.agent = join(this.home, ".pi/agent");
    this.project = join(this.dir, "project");
    mkdirSync(this.agent, { recursive: true });
    mkdirSync(this.project, { recursive: true });
    this.#backend = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        if (new URL(request.url).pathname.endsWith("/content")) {
          const bytes = await request.arrayBuffer();
          this.uploads.push({ size: bytes.byteLength, mediaType: request.headers.get("content-type") });
          return Response.json({ ref: `urn:test:${this.uploads.length}`, size: bytes.byteLength, sha256: request.headers.get("ahp-content-sha256") }, { status: 201 });
        }
        const wire = (await request.json()) as { id?: string; method: string; params: { event: Event } };
        this.received.push(wire.params.event);
        if (this.slow?.type === wire.params.event.type) await Bun.sleep(this.slow.ms);
        if (wire.method === "hooks/observe") return new Response(null, { status: 202 });
        return Response.json({ jsonrpc: "2.0", id: wire.id, result: { protocolVersion: "draft", effects: this.policy(wire.params.event) } });
      },
    });
    this.#model = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        const incoming = (await request.json()) as Request;
        this.requests.push(incoming);
        if (this.delayMs) await Bun.sleep(this.delayMs);
        const last = incoming.messages.at(-1)!;
        const words = text(last.content);
        if (words.includes("MODEL-FAILS")) return new Response("nope", { status: 400 });
        if (words.includes("FAILS-ONCE") && !this.failedOnce) {
          this.failedOnce = true;
          return new Response("overloaded", { status: 500 });
        }
        // Context injected after the prompt does not hide it.
        const trailing = incoming.messages.slice(incoming.messages.findLastIndex((entry) => entry.role !== "user") + 1).map((entry) => text(entry.content)).join("\n");
        const call = last.role === "user" ? /CALL (\S+) (\{.*\})/.exec(trailing) : null;
        const both = last.role === "user" && words.includes("TWO-CALLS");
        const chunk = (delta: unknown, finish: string | null = null) =>
          `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        const frames = both
          ? [chunk({ role: "assistant", tool_calls: ["one", "two"].map((name, index) => ({ index, id: `call_${name}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: `echo ${name}` }) } })) }), chunk({}, "tool_calls")]
          : call
          ? [chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${crypto.randomUUID().slice(0, 8)}`, type: "function", function: { name: call[1], arguments: call[2] } }] }), chunk({}, "tool_calls")]
          : [chunk({ role: "assistant", content: "final answer" }), chunk({}, "stop")];
        frames.push(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\n`, "data: [DONE]\n\n");
        return new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } });
      },
    });
    writeFileSync(join(this.agent, "models.json"), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${this.#model.port}/v1`, api: "openai-completions", apiKey: "x", compat: { supportsDeveloperRole: false }, models: [{ id: "m", reasoning: true, input: ["text", "image"], contextWindow: 100000 }, { id: "n", contextWindow: 100000 }] } } }));
    writeFileSync(join(this.agent, "settings.json"), JSON.stringify({ compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 100 }, retry: options.retry ? { enabled: true, maxRetries: 2, baseDelayMs: 10 } : { enabled: false }, ...(options.codemode ? { defaultTools: ["codemode", "bash"] } : {}) }));
    if (options.mcp) writeFileSync(join(this.agent, "mcp.json"), JSON.stringify({ mcpServers: { "my-docs": { exposure: "direct", command: "bun", args: [join(import.meta.dir, "mcp-server.ts")], env: { SECRET_TOKEN: "do-not-leak" } } } }));
    const content = { default: "body" };
    writeFileSync(join(this.dir, "hooks.json"), JSON.stringify({
      protocolVersion: "draft",
      hooks: [{
        id: "org.example.recorder",
        transport: { type: "http", url: `http://127.0.0.1:${this.#backend.port}/ahp` },
        subscriptions: [
          { mode: "intercept", events: INTERCEPT, timeoutMs: 10000, failurePolicy: "fail-closed", content },
          { mode: "observe", events: OBSERVE, content },
        ],
      }],
    }));
  }

  /** Register another backend beside the recorder. */
  add(backend: Record<string, unknown>): void {
    const file = join(this.dir, "hooks.json");
    const document = JSON.parse(readFileSync(file, "utf8")) as { hooks: unknown[] };
    document.hooks.push(backend);
    writeFileSync(file, JSON.stringify(document));
  }

  /** The UI requests of one method since `from`. */
  uiOf(method: string, from = 0): Record<string, any>[] {
    return this.ui.slice(from).filter((request) => request.method === method);
  }

  of(type: string): Event[] {
    return this.received.filter((event) => event.type === type);
  }

  start(env: Record<string, string> = {}, extra: string[] = []): void {
    this.#pi = Bun.spawn(["node", this.cli, "-e", installed, ...extra, "--provider", "fake", "--model", "m", "--mode", "rpc"], {
      cwd: this.project,
      stdin: "pipe",
      stdout: "pipe",
      stderr: Bun.file(join(this.dir, "pi.err")),
      env: { PATH: process.env.PATH!, HOME: this.home, PI_CODING_AGENT_DIR: this.agent, PI_OFFLINE: "1", AHP_HOOKS_FILE: join(this.dir, "hooks.json"), ...(process.env.AHP_DEBUG ? { AHP_DEBUG: "1" } : {}), ...env },
    });
    void this.#read();
  }

  /** Another pi of the same user, beside this one: same home, store and hooks. */
  another(env: Record<string, string> = {}) {
    const child = Bun.spawn(["node", this.cli, "-e", installed, "--provider", "fake", "--model", "m", "--mode", "rpc"], {
      cwd: this.project,
      stdin: "pipe",
      stdout: "pipe",
      stderr: Bun.file(join(this.dir, "pi-other.err")),
      env: { PATH: process.env.PATH!, HOME: this.home, PI_CODING_AGENT_DIR: this.agent, PI_OFFLINE: "1", AHP_HOOKS_FILE: join(this.dir, "hooks.json"), ...env },
    });
    const ui: Record<string, any>[] = [];
    void (async () => {
      let buffer = "";
      for await (const chunk of child.stdout as unknown as AsyncIterable<Uint8Array>) {
        buffer += new TextDecoder().decode(chunk);
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          try {
            const wire = JSON.parse(line);
            if (wire.type === "extension_ui_request") ui.push(wire);
          } catch {}
        }
      }
    })();
    const stdin = child.stdin as unknown as { write(text: string): void; flush(): void; end(): void };
    return {
      ui,
      send(command: Record<string, unknown>) {
        stdin.write(`${JSON.stringify(command)}\n`);
        stdin.flush();
      },
      async stop() {
        stdin.end();
        await Promise.race([child.exited, Bun.sleep(8000).then(() => child.kill())]);
      },
    };
  }

  async #read(): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of this.#pi!.stdout as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk);
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let wire: Record<string, any>;
        try {
          wire = JSON.parse(line);
        } catch {
          continue;
        }
        if (wire.type === "extension_error") this.errors.push(wire);
        if (wire.type === "response") this.responses.push(wire);
        if (wire.type !== "extension_ui_request") continue;
        this.ui.push(wire);
        if (wire.method === "confirm") this.send({ type: "extension_ui_response", id: wire.id, confirmed: this.confirm });
      }
    }
  }

  send(command: Record<string, unknown>): void {
    const stdin = this.#pi!.stdin as unknown as { write(text: string): void; flush(): void };
    stdin.write(`${JSON.stringify(command)}\n`);
    stdin.flush();
  }

  /** Say something and wait for its turn to end. */
  async say(words: string): Promise<void> {
    const ended = this.of("turn.end").length;
    this.send({ type: "prompt", message: words });
    await this.until(() => this.of("turn.end").length > ended, `the turn for ${words}`);
  }

  call(tool: string, args: unknown): Promise<void> {
    return this.say(`CALL ${tool} ${JSON.stringify(args)}`);
  }

  async until(done: () => boolean, what: string): Promise<void> {
    const started = Date.now();
    while (!done()) {
      if (Date.now() - started > 20000) throw new Error(`timed out waiting for ${what}; stderr: ${existsSync(join(this.dir, "pi.err")) ? readFileSync(join(this.dir, "pi.err"), "utf8").slice(0, 800) : ""}`);
      await Bun.sleep(20);
    }
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#pi) {
      const stdin = this.#pi.stdin as unknown as { end(): void };
      stdin.end();
      await Promise.race([this.#pi.exited, Bun.sleep(8000).then(() => this.#pi!.kill())]);
    }
    await this.#backend.stop(true);
    await this.#model.stop(true);
  }

  /** The texts of the model's last request, without its system prompt. */
  lastRequest(): string[] {
    return this.requests.at(-1)!.messages.slice(1).map((entry) => text(entry.content));
  }
}

/** A certificate for 127.0.0.1 that pi is told to trust: OAuth needs HTTPS. */
let certificate: { cert: string; key: string; file: string } | undefined;
async function tls() {
  if (certificate) return certificate;
  const file = join(root, "cert.pem");
  const keyFile = join(root, "key.pem");
  const openssl = Bun.spawn(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile, "-out", file, "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-addext", "basicConstraints=critical,CA:TRUE"], { stdout: "ignore", stderr: "pipe" });
  if ((await openssl.exited) !== 0) throw new Error(await new Response(openssl.stderr).text());
  certificate = { cert: readFileSync(file, "utf8"), key: readFileSync(keyFile, "utf8"), file };
  return certificate;
}

const base64url = (bytes: ArrayBuffer) => Buffer.from(bytes).toString("base64url");

/** An AHP backend behind OAuth, and its authorization server: protected-resource
 * and server metadata, dynamic registration, authorization and a token endpoint
 * that verifies PKCE. One origin plays both. */
async function protectedBackend() {
  const { cert, key } = await tls();
  const issued = new Set<string>();
  const codes = new Map<string, { client: string; challenge: string; redirect: string; resource: string | null }>();
  const received: { type: string; authorization: string | null }[] = [];
  const metadata: string[] = [];
  const registrations: Record<string, unknown>[] = [];
  const authorizations: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    tls: { cert, key },
    fetch: async (request) => {
      const url = new URL(request.url);
      const origin = url.origin;
      if (url.pathname.startsWith("/.well-known/")) metadata.push(url.pathname);
      if (url.pathname === "/.well-known/oauth-protected-resource/ahp") {
        return Response.json({ resource: `${origin}/ahp`, authorization_servers: [origin] });
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          authorization_response_iss_parameter_supported: true,
        });
      }
      if (url.pathname === "/register" && request.method === "POST") {
        const metadata = (await request.json()) as Record<string, unknown>;
        registrations.push(metadata);
        return Response.json({ ...metadata, client_id: `client-${registrations.length}`, client_id_issued_at: Math.floor(Date.now() / 1000), token_endpoint_auth_method: "none" }, { status: 201 });
      }
      if (url.pathname === "/authorize") {
        // The person consents: back to the redirect with a code.
        authorizations.push(url.href);
        const code = crypto.randomUUID();
        const redirect = url.searchParams.get("redirect_uri")!;
        codes.set(code, { client: url.searchParams.get("client_id")!, challenge: url.searchParams.get("code_challenge")!, redirect, resource: url.searchParams.get("resource") });
        const back = new URL(redirect);
        back.searchParams.set("code", code);
        back.searchParams.set("state", url.searchParams.get("state")!);
        back.searchParams.set("iss", origin);
        return new Response(null, { status: 302, headers: { location: back.href } });
      }
      if (url.pathname === "/token" && request.method === "POST") {
        const form = new URLSearchParams(await request.text());
        const grant = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        const challenge = base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(form.get("code_verifier") ?? "")));
        if (form.get("grant_type") !== "authorization_code" || !grant || grant.client !== form.get("client_id") || grant.redirect !== form.get("redirect_uri") || grant.challenge !== challenge || form.get("resource") !== `${origin}/ahp`) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        const token = `token-${crypto.randomUUID()}`;
        issued.add(token);
        return Response.json({ access_token: token, token_type: "Bearer", expires_in: 3600 });
      }
      if (url.pathname === "/ahp") {
        const authorization = request.headers.get("authorization");
        if (!authorization || !issued.has(authorization.replace(/^Bearer /, ""))) {
          return new Response(null, { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/ahp"` } });
        }
        const wire = (await request.json()) as { id?: string; method: string; params: { event: Event } };
        received.push({ type: wire.params.event.type, authorization });
        if (wire.method === "hooks/observe") return new Response(null, { status: 202 });
        return Response.json({ jsonrpc: "2.0", id: wire.id, result: { protocolVersion: "draft", effects: [] } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const origin = `https://127.0.0.1:${server.port}`;
  return {
    origin,
    issued,
    received,
    registrations,
    authorizations,
    metadata,
    /** What a browser does with the link: follow it to its redirect, without visiting it. */
    async consent(link: string): Promise<string> {
      const response = await fetch(link, { redirect: "manual", tls: { ca: cert } } as RequestInit);
      return response.headers.get("location")!;
    },
    backend(id = "org.example.protected") {
      return {
        id,
        transport: { type: "http", url: `${origin}/ahp` },
        oauth: { issuer: origin, registration: true, allowPrivateNetwork: true },
        subscriptions: [
          { mode: "intercept", events: ["turn.start"], timeoutMs: 10000, failurePolicy: "fail-open", content: { default: "body" } },
          { mode: "observe", events: ["turn.end"], content: { default: "body" } },
        ],
      };
    },
    stop: () => server.stop(true),
  };
}

const advertised = (manifest: Event, event: string) => manifest.events.find((entry: Event) => entry.event === event);

/** Another extension: starts a run of its own, and reloads. */
const HELPER = `export default function (pi) {
  pi.registerCommand("poke", { description: "", handler: async (args) => { pi.sendMessage({ customType: "helper", content: args, display: false }, { triggerTurn: true }); } });
  pi.registerCommand("reload-now", { description: "", handler: async (_args, ctx) => { await ctx.reload(); } });
}
`;

const VERSIONS = [
  ["1.0.0", join(REPO, "node_modules/pi-floor/dist/cli.js")],
  ["1.5.0", join(REPO, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js")],
] as const;

describe.each(VERSIONS)("pi %s", (version, cli) => {
  const inWorld = async (run: (world: World) => Promise<void>, options: Options = {}) => {
    const world = new World(cli, options);
    writeFileSync(join(world.dir, "helper.ts"), HELPER);
    try {
      await run(world);
      expect(world.errors).toEqual([]);
    } finally {
      await world.stop();
    }
  };

  test("a session's lifecycle reaches a backend, and session.end before pi exits", () => inWorld(async (world) => {
    world.start();
    await world.say("hello");
    await world.stop();
    const start = world.of("session.start")[0]!;
    expect(start).toMatchObject({ trigger: "startup", permissionMode: "default", harness: { name: "pi", version } });
    expect(start.session.id).toBeString();
    expect(start.session.cwd).toBe(world.project);
    expect(start.session.model).toBe("fake/m");
    expect(start.items[0].parts[0].text).toContain("pi");
    expect(start.manifest.gaps.map((gap: { path: string }) => gap.path)).toContain("session.agent");
    expect(start.manifest.gaps.map((gap: { path: string }) => gap.path)).not.toContain("tool.before.ask");
    expect(advertised(start.manifest, "tool.before").capabilities.effects).toContain("ask");
    expect(advertised(start.manifest, "tool.permission.request")).toBeDefined();
    expect(world.of("session.end")[0]).toMatchObject({ reason: "quit", outcome: "completed" });
    expect(world.of("turn.end")[0]).toMatchObject({ outcome: "completed", continuationCount: 0 });
    expect(world.of("turn.end")[0]!.items[0].parts[0].text).toBe("final answer");
    expect(world.of("turn.start")[0]).toMatchObject({ trigger: "user" });
    expect(world.of("turn.start")[0]!.turn.id).toBe(world.of("turn.end")[0]!.turn.id);
    expect(world.of("turn.progress").map((event) => event.delta.parts[0].text).join("")).toBe("final answer");
  }));

  test("session.start's context rides on the first prompt, and its message reaches a person", () => inWorld(async (world) => {
    world.policy = (event) => event.type === "session.start" ? [inject(event, "START-CONTEXT"), { type: "message", text: "welcome" }] : [];
    world.start();
    await world.say("hello");
    expect(world.lastRequest()).toEqual(["hello", "START-CONTEXT"]);
    expect(world.ui.some((entry) => entry.method === "notify" && entry.message === "welcome")).toBe(true);
  }));

  test("a refused prompt reaches no model, and the next prompt begins a new turn", () => inWorld(async (world) => {
    world.policy = (event) => event.type === "turn.start" && JSON.stringify(event.items).includes("REFUSE") ? [{ type: "deny", reason: "not that" }] : [];
    world.start();
    world.send({ type: "prompt", message: "REFUSE this" });
    await world.until(() => world.ui.some((entry) => entry.message === "not that"), "the refusal");
    expect(world.requests).toHaveLength(0);
    expect(world.of("turn.end")).toHaveLength(0);
    await world.say("fine");
    expect(world.of("turn.start")).toHaveLength(2);
    expect(world.of("user.message.inbound")).toHaveLength(0);
  }));

  test("a prompt can be rewritten and annotated", () => inWorld(async (world) => {
    world.policy = (event) => {
      if (event.type !== "turn.start") return [];
      const item = event.items[0];
      return [
        { type: "modify", target: "prompt", operation: "replace", value: [{ ...item, parts: [{ ...item.parts[0], text: "the rewritten prompt" }] }] },
        inject(event, "TURN-CONTEXT"),
      ];
    };
    world.start();
    await world.say("the original");
    expect(world.lastRequest()).toEqual(["the rewritten prompt", "TURN-CONTEXT"]);
  }));

  test("a follow-up into a running turn is inbound, refused or rewritten there", () => inWorld(async (world) => {
    world.delayMs = 300;
    world.policy = (event) => {
      if (event.type !== "user.message.inbound") return [];
      const item = event.message.messages[0];
      if (JSON.stringify(item).includes("REFUSE")) return [{ type: "deny", reason: "no steering" }];
      return [{ type: "modify", target: "prompt", operation: "replace", value: [{ ...item, parts: [{ ...item.parts[0], text: "rewritten follow-up" }] }] }];
    };
    world.start();
    world.send({ type: "prompt", message: "long task" });
    await world.until(() => world.requests.length === 1, "the first request");
    world.send({ type: "follow_up", message: "REFUSE this" });
    world.send({ type: "follow_up", message: "also this" });
    await world.until(() => world.of("turn.end").length === 1, "the turn's end");
    expect(world.of("turn.start")).toHaveLength(1);
    expect(world.of("user.message.inbound")).toHaveLength(2);
    expect(world.lastRequest().join()).toContain("rewritten follow-up");
    expect(world.lastRequest().join()).not.toContain("REFUSE");
    expect(world.of("turn.end")[0]!.outcome).toBe("completed");
  }));

  test("a backend can ask for another pass, up to the limit", () => inWorld(async (world) => {
    world.policy = (event) => event.type === "turn.finish.before" ? [{ type: "flow", operation: "continue", instruction: `AGAIN-${event.continuationCount}` }] : [];
    world.start();
    await world.say("hello");
    const finishes = world.of("turn.finish.before");
    expect(finishes.map((event) => event.continuationCount)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(world.requests).toHaveLength(9);
    expect(world.lastRequest().join()).toContain("AGAIN-7");
    expect(world.of("turn.end")).toHaveLength(1);
    expect(world.of("turn.end")[0]).toMatchObject({ continuationCount: 8, outcome: "completed" });
    expect(finishes[0]!.items[0].parts[0].text).toBe("final answer");
  }));

  test("a request can be read whole, refused, and rewritten for itself alone", () => inWorld(async (world) => {
    let rewrote = false;
    world.policy = (event) => {
      if (event.type !== "model.request.before") return [];
      const words = JSON.stringify(event.items);
      if (words.includes("REFUSE-REQUEST")) return [{ type: "deny", reason: "no request" }];
      if (!words.includes("REWRITE-REQUEST") || rewrote) return [];
      rewrote = true;
      const items = event.items.map((item: Event) => item.role === "system"
        ? { ...item, parts: [{ ...item.parts[0], text: "THE-SYSTEM-PROMPT" }] }
        : { ...item, parts: [{ ...item.parts[0], text: "rewritten request" }] });
      return [
        { type: "modify", target: "request", operation: "replace", value: [...items, { id: "added", role: "user", parts: [{ id: "added#0", ...body("ADDED") }] }] },
        inject(event, "REQUEST-CONTEXT"),
      ];
    };
    world.start();
    await world.say("REWRITE-REQUEST");
    const request = world.requests.at(-1)!;
    expect(text(request.messages[0]!.content)).toBe("THE-SYSTEM-PROMPT");
    // The prompt changed: the model's tools did not.
    expect(request.tools!.length).toBeGreaterThan(0);
    expect(world.lastRequest()).toEqual(["rewritten request", "ADDED", "REQUEST-CONTEXT"]);
    const before = world.of("model.request.before")[0]!;
    expect(before.items[0].role).toBe("system");
    expect(before).toMatchObject({ model: { id: "m", provider: "fake" }, attempt: { number: 1 } });
    // Not written to the session: the next turn's request has the original.
    await world.say("next");
    expect(world.lastRequest()[0]).toBe("REWRITE-REQUEST");
    expect(world.lastRequest()).not.toContain("REQUEST-CONTEXT");

    const made = world.requests.length;
    await world.say("REFUSE-REQUEST");
    expect(world.requests).toHaveLength(made);
    expect(world.of("turn.end").at(-1)).toMatchObject({ outcome: "failed", error: { class: "Denied", message: "no request" } });
    expect(world.ui.some((entry) => entry.message === "no request")).toBe(true);
  }));

  test("a response is reported with its usage, and can be rewritten", () => inWorld(async (world) => {
    world.policy = (event) => {
      if (event.type !== "model.response.after") return [];
      const item = event.items[0];
      return [{ type: "modify", target: "response", operation: "replace", value: [{ ...item, parts: [{ ...item.parts[0], text: "the rewritten answer" }] }] }];
    };
    world.start();
    await world.say("hello");
    await world.say("again");
    const response = world.of("model.response.after")[0]!;
    expect(response).toMatchObject({ finishReason: "stop", model: { id: "m", provider: "fake" }, usage: { inputTokens: 5, outputTokens: 2 } });
    expect(world.lastRequest()).toEqual(["hello", "the rewritten answer", "again"]);
    expect(world.of("turn.end")[0]!.items[0].parts[0].text).toBe("the rewritten answer");
  }));

  test("identities hold from a response to the next request", () => inWorld(async (world) => {
    world.start();
    await world.say("hello");
    await world.say("again");
    const id = world.of("model.response.after")[0]!.items[0].id;
    expect(world.of("model.request.before")[1]!.items.map((item: Event) => item.id)).toContain(id);
  }));

  test("a failed request is model.error and a failed turn", () => inWorld(async (world) => {
    world.start();
    await world.say("MODEL-FAILS");
    expect(world.of("model.error")[0]).toMatchObject({ error: { class: "ProviderError" }, execution: { status: "executed" } });
    expect(world.of("model.error")[0]!.error.message).toContain("nope");
    expect(world.of("turn.end")[0]).toMatchObject({ outcome: "failed", error: { class: "ProviderError" } });
    expect(world.of("turn.finish.before")).toHaveLength(0);
  }));

  test("an abort is a cancelled turn", () => inWorld(async (world) => {
    world.delayMs = 1000;
    world.start();
    world.send({ type: "prompt", message: "long" });
    await world.until(() => world.requests.length === 1, "the request");
    world.send({ type: "abort" });
    await world.until(() => world.of("turn.end").length === 1, "the turn's end");
    expect(world.of("turn.end")[0]!.outcome).toBe("cancelled");
    expect(world.of("model.error")).toHaveLength(0);
  }));

  test("a model selection is reported, and a refused one undone before the next request", () => inWorld(async (world) => {
    world.policy = (event) => event.type === "model.switch.before" && event.proposed.id === "n" && refuse ? [{ type: "deny", reason: "stay" }] : [];
    let refuse = true;
    world.start();
    await world.say("first");
    world.send({ type: "set_model", provider: "fake", modelId: "n" });
    await world.until(() => world.ui.some((entry) => entry.message === "stay"), "the refusal");
    expect(world.of("model.switch.after")).toHaveLength(0);
    await world.say("second");
    expect(world.requests.at(-1)!.model).toBe("m");
    refuse = false;
    world.send({ type: "set_model", provider: "fake", modelId: "n" });
    await world.until(() => world.of("model.switch.after").length === 1, "the switch");
    expect(world.of("model.switch.after")[0]).toMatchObject({ previous: { id: "m" }, current: { id: "n" }, reason: "set" });
    await world.say("third");
    expect(world.requests.at(-1)!.model).toBe("n");
    expect(world.of("model.switch.before")).toHaveLength(2);
  }));

  test("a thinking level is a configuration change", () => inWorld(async (world) => {
    world.start();
    await world.say("hello");
    world.send({ type: "set_thinking_level", level: "minimal" });
    world.send({ type: "set_thinking_level", level: "high" });
    await world.until(() => world.of("config.change.after").length > 0, "the change");
    expect(world.of("config.change.after")[0]!.change).toMatchObject({ scope: "session", source: "pi", settings: ["thinkingLevel"] });
  }));

  test("a retry is another attempt at one request, and the turn completes", () => inWorld(async (world) => {
    world.start();
    await world.say("FAILS-ONCE");
    expect(world.of("model.error")).toHaveLength(1);
    const attempts = world.of("model.request.before").map((event) => event.attempt.number);
    expect(attempts).toEqual([1, 2]);
    expect(world.of("model.response.after")[0]!.attempt.number).toBe(2);
    expect(world.of("turn.end")).toHaveLength(1);
    expect(world.of("turn.end")[0]).toMatchObject({ outcome: "completed" });
    expect(world.of("turn.end")[0]!.error).toBeUndefined();
  }, { retry: true }));

  test("an abort reaches a delivery in flight: the call is cancelled, not refused", () => inWorld(async (world) => {
    world.slow = { type: "tool.before", ms: 3000 };
    world.start();
    world.send({ type: "prompt", message: `CALL write {"path":"made.txt","content":"x"}` });
    await world.until(() => world.of("tool.before").length === 1, "the delivery");
    world.send({ type: "abort" });
    await world.until(() => world.of("turn.end").length === 1, "the turn's end");
    expect(existsSync(join(world.project, "made.txt"))).toBe(false);
    expect(world.of("tool.after")[0]).toMatchObject({ outcome: "cancelled", execution: { status: "skipped", reason: "cancelled" } });
    expect(world.of("turn.end")[0]!.outcome).toBe("cancelled");
  }));

  test("images leave by upload, never in event text", () => inWorld(async (world) => {
    const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    writeFileSync(join(world.project, "pixel.png"), Buffer.from(pixel, "base64"));
    const registration = JSON.parse(readFileSync(join(world.dir, "hooks.json"), "utf8"));
    const url = registration.hooks[0].transport.url;
    registration.hooks[0].subscriptions = [{ mode: "intercept", events: ["turn.start", "tool.after"], timeoutMs: 10000, failurePolicy: "fail-closed", content: { default: "body" }, upload: { endpoint: `${url}/content`, timeoutMs: 5000, maxBytes: 1048576 } }];
    writeFileSync(join(world.dir, "hooks.json"), JSON.stringify(registration));
    world.start();
    world.send({ type: "prompt", message: `CALL read {"path":"pixel.png"}`, images: [{ type: "image", data: pixel, mimeType: "image/png" }] });
    await world.until(() => world.requests.length === 2, "the second request");
    await world.until(() => world.of("tool.after").length === 1, "tool.after");
    expect(JSON.stringify(world.received)).not.toContain(pixel);
    const part = world.of("turn.start")[0]!.items[0].parts[1];
    expect(part).toMatchObject({ kind: "attachment", mediaType: "image/png", selection: "body", body: { ref: "urn:test:1" } });
    expect(world.of("tool.after")[0]!.items[0].parts.some((item: Event) => item.kind === "attachment")).toBe(true);
    expect(world.uploads.length).toBe(2);
    expect(world.uploads[0]!.size).toBe(Buffer.from(pixel, "base64").length);
    // The model still has the prompt's image and the tool's.
    expect(JSON.stringify(world.requests[1]!.messages)).toContain(pixel);
  }));

  test("a turn an extension starts is a turn, and can be refused", () => inWorld(async (world) => {
    let refuse = false;
    world.policy = (event) => event.type === "turn.start" && refuse ? [{ type: "deny", reason: "not that either" }] : [];
    world.start({}, ["-e", join(world.dir, "helper.ts")]);
    world.send({ type: "prompt", message: "/poke NUDGE" });
    await world.until(() => world.of("turn.end").length === 1, "the nudged turn");
    expect(world.of("turn.start")[0]).toMatchObject({ trigger: "external" });
    expect(JSON.stringify(world.requests.at(-1)!.messages)).toContain("NUDGE");
    const made = world.requests.length;
    refuse = true;
    world.send({ type: "prompt", message: "/poke AGAIN" });
    await world.until(() => world.of("turn.end").length === 2, "the refused turn");
    expect(world.requests).toHaveLength(made);
    expect(world.of("turn.end")[1]!.outcome).toBe("cancelled");
    // pi has saved the refused message by then: the model still does not read it.
    if (version !== "1.0.0") {
      refuse = false;
      await world.say("next");
      expect(JSON.stringify(world.requests.at(-1)!.messages)).not.toContain("AGAIN");
    }
  }));

  test("a reload is the same session under a new instance", () => inWorld(async (world) => {
    world.start({}, ["-e", join(world.dir, "helper.ts")]);
    await world.say("hello");
    world.send({ type: "prompt", message: "/reload-now" });
    await Bun.sleep(1500);
    await world.say("still here");
    expect(world.of("session.start")).toHaveLength(1);
    expect(world.of("session.end")).toHaveLength(0);
    expect(world.of("turn.end")).toHaveLength(2);
    expect(world.of("turn.end")[1]!.session.id).toBe(world.of("session.start")[0]!.session.id);
  }));

  test("a fork is a new session that names where it came from", () => inWorld(async (world) => {
    world.start();
    await world.say("hello");
    const first = world.of("session.start")[0]!.session.id;
    world.send({ type: "get_fork_messages" });
    await world.until(() => world.responses.some((entry) => entry.command === "get_fork_messages"), "the fork points");
    const entryId = world.responses.find((entry) => entry.command === "get_fork_messages")!.data.messages[0].entryId;
    world.send({ type: "fork", entryId });
    await world.until(() => world.of("session.start").length === 2, "the fork");
    expect(world.of("session.start")[1]).toMatchObject({ trigger: "fork", resumedFrom: { id: first } });
    expect(world.of("session.end")[0]).toMatchObject({ reason: "fork" });
  }));

  test("with no UI, ask is not offered, and everything is delivered before pi exits", () => inWorld(async (world) => {
    const offered: unknown[] = [];
    world.policy = (event) => {
      if (event.type !== "tool.before") return [];
      offered.push(event);
      return [{ type: "ask" }];
    };
    const child = Bun.spawn(["node", cli, "-e", installed, "--provider", "fake", "--model", "m", "-p", `CALL write {"path":"made.txt","content":"x"}`], {
      cwd: world.project,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: { PATH: process.env.PATH!, HOME: world.home, PI_CODING_AGENT_DIR: world.agent, PI_OFFLINE: "1", AHP_HOOKS_FILE: join(world.dir, "hooks.json") },
    });
    await child.exited;
    const manifest = world.of("session.start")[0]!.manifest;
    const toolBefore = advertised(manifest, "tool.before");
    expect(toolBefore.capabilities.effects).not.toContain("ask");
    expect(toolBefore.capabilities.effects).toContain("deny");
    expect(manifest.gaps.map((gap: { path: string }) => gap.path)).toContain("tool.permission");
    expect(manifest.gaps.map((gap: { path: string }) => gap.path)).toContain("tool.before.ask");
    expect(offered).toHaveLength(1);
    // An effect nobody offered breaks the contract: this backend's policy is fail-closed.
    expect(existsSync(join(world.project, "made.txt"))).toBe(false);
    expect(world.of("tool.permission.request")).toHaveLength(0);
    expect(world.lastRequest().at(-1)).toContain("fail-closed");
    expect(world.of("turn.end")).toHaveLength(1);
    expect(world.of("session.end")).toHaveLength(1);
  }));

  test("context injected at tool.before or tool.after survives a failed tool", () => inWorld(async (world) => {
    world.policy = (event) => {
      if (event.type === "tool.before") return [inject(event, "BEFORE-CONTEXT")];
      if (event.type === "tool.after") return [inject(event, "AFTER-CONTEXT")];
      return [];
    };
    world.start();
    await world.call("bash", { command: "exit 3" });
    const read = world.lastRequest().at(-1)!;
    expect(read).toContain("BEFORE-CONTEXT");
    expect(read).toContain("AFTER-CONTEXT");
  }));

  test("a tool call is before, progress and after, under one id", () => inWorld(async (world) => {
    world.start();
    await world.call("bash", { command: "echo hi" });
    const before = world.of("tool.before")[0]!;
    const after = world.of("tool.after")[0]!;
    expect(before).toMatchObject({ tool: { name: "bash", origin: "native", input: { command: "echo hi" } }, path: "native" });
    expect(after).toMatchObject({ outcome: "ok", execution: { status: "executed" }, parentEventId: before.id, call: { id: before.call.id } });
    expect(after.items[0].parts[0].text).toContain("hi");
    expect(world.of("tool.progress").length).toBeGreaterThan(0);
    const batch = world.of("tool.batch.after")[0]!;
    expect(batch.calls[0]).toMatchObject({ call: { id: before.call.id }, outcome: "ok", tool: { name: "bash", input: { command: "echo hi" } } });
  }));

  test("a denied call does not run, and the model reads why", () => inWorld(async (world) => {
    world.policy = (event) => event.type === "tool.before" ? [{ type: "deny", reason: "refused tool" }] : [];
    world.start();
    await world.call("write", { path: "made.txt", content: "x" });
    expect(existsSync(join(world.project, "made.txt"))).toBe(false);
    expect(world.lastRequest().at(-1)).toBe("refused tool");
    expect(world.of("tool.after")[0]).toMatchObject({ outcome: "denied", execution: { status: "skipped", reason: "policy" } });
    expect(world.of("tool.batch.after")[0]!.calls[0]).toMatchObject({ outcome: "denied" });
    expect(world.of("file.changed")).toHaveLength(0);
  }));

  test("input can be rewritten: the tool runs what the backend says", () => inWorld(async (world) => {
    world.policy = (event) => event.type === "tool.before" ? [{ type: "modify", target: "input", operation: "replace", value: { command: "echo rewritten-input" } }] : [];
    world.start();
    await world.call("bash", { command: "echo original" });
    expect(world.lastRequest().at(-1)).toContain("rewritten-input");
    expect(world.of("tool.after")[0]!.tool.input).toEqual({ command: "echo rewritten-input" });
  }));

  test("a supplied result stands in for the tool, read by the model as a success", () => inWorld(async (world) => {
    world.policy = (event) => event.type === "tool.before" ? [{ type: "return", value: [{ id: "r", role: "tool", parts: [{ id: "r#0", ...body("SUPPLIED") }] }] }] : [];
    world.start();
    await world.call("write", { path: "made.txt", content: "x" });
    expect(existsSync(join(world.project, "made.txt"))).toBe(false);
    expect(world.lastRequest().at(-1)).toBe("SUPPLIED");
    expect(world.of("tool.after")[0]).toMatchObject({ outcome: "ok", execution: { status: "skipped", reason: "supplied_result" } });
    expect(world.of("tool.after")).toHaveLength(1);
  }));

  test("output can be rewritten, and tool.before's and tool.after's context both reach the model", () => inWorld(async (world) => {
    world.policy = (event) => {
      if (event.type === "tool.before") return [inject(event, "BEFORE-CONTEXT")];
      if (event.type !== "tool.after") return [];
      const item = event.items[0];
      return [
        { type: "modify", target: "output", operation: "replace", value: [{ ...item, parts: [{ ...item.parts[0], text: "rewritten output" }] }] },
        inject(event, "AFTER-CONTEXT"),
      ];
    };
    world.start();
    await world.call("bash", { command: "echo hi" });
    expect(world.lastRequest().at(-1)).toBe("rewritten output\nBEFORE-CONTEXT\nAFTER-CONTEXT");
  }));

  test("two calls in one response: each has its own events, and one batch has both", () => inWorld(async (world) => {
    world.policy = (event) => event.type === "tool.before" && event.tool.input.command === "echo two" ? [{ type: "deny", reason: "not two" }] : [];
    world.start();
    await world.say("TWO-CALLS");
    expect(world.of("tool.before").map((event) => event.call.id).sort()).toEqual(["call_one", "call_two"]);
    const afters = Object.fromEntries(world.of("tool.after").map((event) => [event.call.id, event]));
    expect(afters.call_one).toMatchObject({ outcome: "ok" });
    expect(afters.call_two).toMatchObject({ outcome: "denied" });
    expect(world.of("tool.after")).toHaveLength(2);
    const batch = world.of("tool.batch.after");
    expect(batch).toHaveLength(1);
    expect(Object.fromEntries(batch[0]!.calls.map((call: Event) => [call.call.id, call.outcome]))).toEqual({ call_one: "ok", call_two: "denied" });
  }));

  test("a response rewritten without its tool call runs no tool", () => inWorld(async (world) => {
    world.policy = (event) => {
      if (event.type !== "model.response.after" || !JSON.stringify(event.items).includes("write")) return [];
      const item = event.items[0];
      return [{ type: "modify", target: "response", operation: "replace", value: [{ ...item, parts: [{ id: "new", ...body("no tools for you") }] }] }];
    };
    world.start();
    await world.call("write", { path: "made.txt", content: "x" });
    expect(existsSync(join(world.project, "made.txt"))).toBe(false);
    expect(world.of("tool.before")).toHaveLength(0);
    expect(world.of("turn.end")[0]).toMatchObject({ outcome: "completed" });
    expect(world.of("turn.end")[0]!.items[0].parts[0].text).toBe("no tools for you");
  }));

  test("ask comes before a supplied result: a no refuses it", () => inWorld(async (world) => {
    world.confirm = false;
    world.policy = (event) => event.type === "tool.before" ? [{ type: "ask" }, { type: "return", value: [{ id: "r", role: "tool", parts: [{ id: "r#0", ...body("SUPPLIED") }] }] }] : [];
    world.start();
    await world.call("bash", { command: "echo hi" });
    expect(world.ui.some((entry) => entry.method === "confirm")).toBe(true);
    expect(world.lastRequest().at(-1)).toBe("The person declined this tool call");
    expect(world.of("tool.after")[0]).toMatchObject({ outcome: "denied" });
  }));

  test("flow stop at the permission stage still reports the call", () => inWorld(async (world) => {
    world.policy = (event) => {
      if (event.type === "tool.before") return [{ type: "ask" }];
      if (event.type === "tool.permission.request") return [{ type: "flow", operation: "stop", reason: "halt" }];
      return [];
    };
    world.start();
    await world.call("write", { path: "made.txt", content: "x" });
    expect(existsSync(join(world.project, "made.txt"))).toBe(false);
    expect(world.of("tool.after")[0]).toMatchObject({ outcome: "denied" });
    expect(world.of("turn.end")[0]!.outcome).toBe("cancelled");
  }));

  test("a tool that ran and was then aborted reports that it ran", () => inWorld(async (world) => {
    world.start();
    world.send({ type: "prompt", message: `CALL bash {"command":"touch started.txt; sleep 5"}` });
    await world.until(() => existsSync(join(world.project, "started.txt")), "the tool to start");
    world.send({ type: "abort" });
    await world.until(() => world.of("turn.end").length === 1, "the turn's end");
    expect(world.of("tool.after")[0]).toMatchObject({ outcome: "cancelled", execution: { status: "executed" } });
  }));

  test("context injected at every request appears once", () => inWorld(async (world) => {
    world.policy = (event) => event.type === "model.request.before" ? [inject(event, "EVERY-REQUEST")] : [];
    world.start();
    await world.call("bash", { command: "echo hi" });
    expect(world.lastRequest().filter((words) => words === "EVERY-REQUEST")).toHaveLength(1);
    expect(world.requests).toHaveLength(2);
  }));

  test("a !! command is not reported as something the model reads, and a ! one can be rewritten", () => inWorld(async (world) => {
    world.policy = (event) => {
      if (event.type !== "model.request.before" || !JSON.stringify(event.items).includes("visible-output")) return [];
      const items = event.items.map((item: Event) => JSON.stringify(item).includes("visible-output")
        ? { ...item, parts: item.parts.map((part: Event) => part.text?.includes("visible-output") ? { ...part, text: "REDACTED" } : part) }
        : item);
      return [{ type: "modify", target: "request", operation: "replace", value: items }];
    };
    world.start();
    world.send({ type: "bash", command: "echo visible-output" });
    world.send({ type: "bash", command: "echo private-output", excludeFromContext: true });
    // pi holds a command's output back from a run that started while it ran.
    await world.until(() => world.responses.filter((entry) => entry.command === "bash").length === 2, "the commands");
    await world.say("hello");
    expect(JSON.stringify(world.requests.at(-1)!.messages)).toContain("REDACTED");
    expect(JSON.stringify(world.requests.at(-1)!.messages)).not.toContain("visible-output");
    expect(JSON.stringify(world.of("model.request.before"))).not.toContain("private-output");
  }));

  test("an invalid backend does not take a valid one's policy with it", () => inWorld(async (world) => {
    const registration = JSON.parse(readFileSync(join(world.dir, "hooks.json"), "utf8"));
    registration.hooks.unshift({ id: "org.example.broken", transport: { type: "carrier-pigeon" } });
    writeFileSync(join(world.dir, "hooks.json"), JSON.stringify(registration));
    world.policy = (event) => event.type === "tool.before" ? [{ type: "deny", reason: "still enforced" }] : [];
    world.start();
    await world.call("write", { path: "made.txt", content: "x" });
    expect(existsSync(join(world.project, "made.txt"))).toBe(false);
    expect(world.ui.some((entry) => String(entry.message).includes("org.example.broken"))).toBe(true);
  }));

  test("a broken hooks.json is said out loud", () => inWorld(async (world) => {
    writeFileSync(join(world.dir, "hooks.json"), "{nope");
    world.start();
    world.send({ type: "prompt", message: "hello" });
    await world.until(() => world.requests.length === 1, "the request");
    expect(world.ui.some((entry) => String(entry.message).includes("not JSON"))).toBe(true);
  }));

  test("a failed tool is tool.after with its error and no output", () => inWorld(async (world) => {
    world.start();
    await world.call("bash", { command: "exit 3" });
    const after = world.of("tool.after")[0]!;
    expect(after).toMatchObject({ outcome: "error", execution: { status: "executed" }, error: { class: "ToolError" }, items: [] });
    expect(world.of("tool.batch.after")[0]!.calls[0].outcome).toBe("error");
  }));

  test("a call that never ran still gets its one tool.after", () => inWorld(async (world) => {
    world.start();
    await world.call("nosuch", { a: 1 });
    expect(world.of("tool.before")).toHaveLength(0);
    expect(world.of("tool.after")).toHaveLength(1);
    expect(world.of("tool.after")[0]).toMatchObject({ tool: { name: "nosuch" }, outcome: "error", execution: { status: "skipped", reason: "other" } });
  }));

  test("ask raises a dialog: a person's yes runs the tool, a no refuses it", () => inWorld(async (world) => {
    world.policy = (event) => event.type === "tool.before" ? [{ type: "ask" }] : [];
    world.start();
    await world.call("bash", { command: "echo asked" });
    expect(world.ui.some((entry) => entry.method === "confirm")).toBe(true);
    expect(world.lastRequest().at(-1)).toContain("asked");
    expect(world.of("tool.permission.request")).toHaveLength(1);
    expect(world.of("tool.permission.resolved")[0]).toMatchObject({ decision: "allow", decidedBy: "user" });
    await world.until(() => world.of("user.attention").length > 0, "user.attention");
    expect(world.of("user.attention")[0]!.attention.kind).toBe("permission");

    world.confirm = false;
    await world.call("bash", { command: "echo declined" });
    expect(world.lastRequest().at(-1)).toBe("The person declined this tool call");
    expect(world.of("tool.permission.resolved")[1]).toMatchObject({ decision: "deny", decidedBy: "user" });
    expect(world.of("tool.after")[1]).toMatchObject({ outcome: "denied" });
  }));

  test("tool.permission.request answers before anyone is asked", () => inWorld(async (world) => {
    world.policy = (event) => {
      if (event.type === "tool.before") return [{ type: "ask" }];
      if (event.type !== "tool.permission.request") return [];
      return JSON.stringify(event.tool.input).includes("reject-me") ? [{ type: "deny", reason: "no" }] : [{ type: "allow" }];
    };
    world.start();
    await world.call("bash", { command: "echo fine" });
    expect(world.of("tool.permission.resolved")[0]).toMatchObject({ decision: "allow", decidedBy: "hook" });
    await world.call("bash", { command: "echo reject-me" });
    expect(world.of("tool.permission.resolved")[1]).toMatchObject({ decision: "deny", decidedBy: "hook" });
    expect(world.lastRequest().at(-1)).toBe("no");
    expect(world.ui.some((entry) => entry.method === "confirm")).toBe(false);
  }));

  test("a batch can add context, or stop the turn after it", () => inWorld(async (world) => {
    let stop = false;
    world.policy = (event) => {
      if (event.type !== "tool.batch.after") return [];
      return stop ? [{ type: "flow", operation: "stop", reason: "enough" }] : [inject(event, "BATCH-CONTEXT")];
    };
    world.start();
    await world.call("bash", { command: "echo one" });
    expect(world.lastRequest().at(-1)).toBe("BATCH-CONTEXT");
    stop = true;
    const made = world.requests.length;
    await world.call("bash", { command: "echo two" });
    expect(world.requests).toHaveLength(made + 1);
    expect(world.of("turn.end").at(-1)!.outcome).toBe("cancelled");
  }));

  test("the file tools report what they changed", () => inWorld(async (world) => {
    world.start();
    await world.call("write", { path: "made.txt", content: "x" });
    await world.call("write", { path: "made.txt", content: "y" });
    const path = join(world.project, "made.txt");
    expect(world.of("file.changed").map((event) => event.changes[0])).toEqual([
      { path, operation: "create", agentCaused: true },
      { path, operation: "update", agentCaused: true },
    ]);
  }));

  test("an MCP tool is described as MCP, with no credential", () => inWorld(async (world) => {
    world.policy = (event) => {
      if (event.type !== "tool.after") return [];
      const item = event.items[0];
      return [{ type: "modify", target: "output", operation: "replace", value: [{ ...item, parts: [{ ...item.parts[0], text: "rewritten mcp output" }] }] }];
    };
    world.start();
    await Bun.sleep(1500);
    await world.call("mcp__my_docs__search", { q: "x" });
    const before = world.of("tool.before")[0]!;
    expect(before).toMatchObject({ path: "mcp", tool: { name: "mcp__my_docs__search", origin: "mcp", mcp: { provenance: "inferred", server: { id: "my-docs" }, toolName: "search", connection: { transport: "stdio" } } } });
    expect(JSON.stringify(world.received)).not.toContain("do-not-leak");
    expect(world.of("tool.after")[0]!.items[0].parts[0].text).toBe("mcp result for x");
    expect(world.lastRequest().at(-1)).toBe("rewritten mcp output");
    expect(world.of("tool.batch.after")[0]!.calls[0].tool.mcp.server.id).toBe("my-docs");
  }, { mcp: true }));

  test("a codemode script's calls hang off the call that made them", () => inWorld(async (world) => {
    world.policy = (event) => event.type === "tool.before" && event.tool.name === "bash" ? [{ type: "deny", reason: "not from a script" }] : [];
    world.start();
    await world.call("codemode", { code: `try { await tools.bash({ command: "echo nested" }); } catch (error) { console.log(String(error)); }` });
    const outer = world.of("tool.before").find((event) => event.tool.name === "codemode")!;
    const inner = world.of("tool.before").find((event) => event.tool.name === "bash")!;
    expect(inner.call.id).toStartWith(`${outer.call.id}/`);
    expect(inner.parentEventId).toBe(outer.id);
    expect(world.of("tool.after").find((event) => event.tool.name === "bash")).toMatchObject({ outcome: "denied", call: { id: inner.call.id } });
    expect(world.lastRequest().at(-1)).toContain("not from a script");
  }, { codemode: true }));

  test("a compaction can be refused, given a summary, or given instructions", () => inWorld(async (world) => {
    let mode = "refuse";
    world.policy = (event) => {
      if (event.type !== "context.compact.before") return [];
      if (mode === "refuse") return [{ type: "deny", reason: "keep it all" }];
      if (mode === "summary") return [{ type: "return", value: [{ id: "s", ...body("SUPPLIED-SUMMARY") }] }];
      return [{ type: "modify", target: "instructions", operation: "merge", value: [{ id: "c", ...body("KEEP-THE-PLAN") }] }];
    };
    world.start();
    await world.say("hello");
    await world.say("again");

    world.send({ type: "compact", customInstructions: "focus" });
    await world.until(() => world.of("context.compact.before").length === 1, "the refused compaction");
    await Bun.sleep(300);
    expect(world.of("context.compact.before")[0]).toMatchObject({ trigger: "manual" });
    expect(world.of("context.compact.before")[0]!.instructions[0].text).toBe("focus");
    expect(world.of("context.compact.before")[0]!.items.length).toBeGreaterThan(0);
    expect(world.of("context.compact.after")).toHaveLength(0);

    mode = "summary";
    world.send({ type: "compact" });
    await world.until(() => world.of("context.compact.after").length === 1, "the summary");
    expect(world.of("context.compact.after")[0]).toMatchObject({ execution: { status: "executed" } });
    expect(world.of("context.compact.after")[0]!.summary[0].text).toBe("SUPPLIED-SUMMARY");
    await world.say("after");
    expect(world.lastRequest()[0]).toContain("SUPPLIED-SUMMARY");

    mode = "instructions";
    await world.say("more");
    const made = world.requests.length;
    world.send({ type: "compact" });
    await world.until(() => world.of("context.compact.after").length === 2, "the instructed compaction");
    const summarizing = world.requests.slice(made).map((request) => JSON.stringify(request.messages)).join();
    expect(summarizing).toContain("KEEP-THE-PLAN");
  }));

  test("a repository cannot choose where a session goes by shipping a hooks.json", () => inWorld(async (world) => {
    mkdirSync(join(world.project, ".pi"), { recursive: true });
    writeFileSync(join(world.project, ".pi/hooks.json"), readFileSync(join(world.dir, "hooks.json")));
    world.start({ AHP_HOOKS_FILE: "" });
    world.send({ type: "prompt", message: "hello" });
    await world.until(() => world.requests.length === 1, "the request");
    await Bun.sleep(500);
    expect(world.received).toHaveLength(0);
    expect(world.ui.some((entry) => String(entry.message).includes("/trust"))).toBe(true);
  }));

  test("a project someone trusted can register a backend", () => inWorld(async (world) => {
    mkdirSync(join(world.project, ".pi"), { recursive: true });
    writeFileSync(join(world.project, ".pi/hooks.json"), readFileSync(join(world.dir, "hooks.json")));
    world.start({ AHP_HOOKS_FILE: "" }, ["--approve"]);
    await world.say("hello");
    expect(world.of("turn.end")).toHaveLength(1);
  }));

  test("/new ends one session and starts another", () => inWorld(async (world) => {
    world.start();
    await world.say("hello");
    const first = world.of("session.start")[0]!.session.id;
    world.send({ type: "new_session" });
    await world.until(() => world.of("session.start").length === 2, "the new session");
    expect(world.of("session.end")[0]).toMatchObject({ reason: "new", session: { id: first } });
    expect(world.of("session.start")[1]).toMatchObject({ trigger: "clear", resumedFrom: { id: first } });
    expect(world.of("session.start")[1]!.session.id).not.toBe(first);
    await world.say("hello there");
    expect(world.of("turn.end")).toHaveLength(2);
    expect(world.of("session.start")).toHaveLength(2);
  }));

  test("an unreachable fail-closed backend refuses, as its policy says", () => inWorld(async (world) => {
    writeFileSync(join(world.dir, "hooks.json"), JSON.stringify({
      protocolVersion: "draft",
      hooks: [{ id: "org.example.down", transport: { type: "http", url: "http://127.0.0.1:9/ahp" }, subscriptions: [{ mode: "intercept", events: ["tool.before"], timeoutMs: 500, failurePolicy: "fail-closed", content: { default: "body" } }] }],
    }));
    world.start();
    world.send({ type: "prompt", message: `CALL write {"path":"made.txt","content":"x"}` });
    await world.until(() => world.requests.length === 2, "the second request");
    expect(existsSync(join(world.project, "made.txt"))).toBe(false);
    expect(world.lastRequest().at(-1)).toContain("fail-closed");
  }));
  test("OAuth: a turn shows the sign-in a delivery needed, the same link each turn, and the next delivery carries the token", () => inWorld(async (world) => {
    const backend = await protectedBackend();
    try {
      world.add(backend.backend());
      world.start({ NODE_EXTRA_CA_CERTS: certificate!.file, BROWSER: "none" });
      // The first turn's delivery is refused: no token yet, and no login made for it.
      await world.say("hello");
      expect(backend.received).toEqual([]);
      const hint = () => world.uiOf("setWidget").map((request) => request.widgetLines?.[0]).filter((line): line is string => typeof line === "string" && line.startsWith("Sign in to org.example.protected: "));
      await world.say("again");
      await world.until(() => hint().length > 0, "the sign-in hint");
      const link = hint()[0]!.slice("Sign in to org.example.protected: ".length);
      expect(new URL(link).origin).toBe(backend.origin);
      // A port of this sign-in's own.
      const redirect = new URL(link).searchParams.get("redirect_uri")!;
      expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
      // Never in the transcript the model reads.
      expect(world.requests.flatMap((request) => request.messages.map((entry) => text(entry.content))).join("\n")).not.toContain(link);
      // Another turn: the same link, not another login or registration.
      await world.say("and again");
      await Bun.sleep(300);
      expect(new Set(hint())).toEqual(new Set([`Sign in to org.example.protected: ${link}`]));
      expect(backend.registrations).toHaveLength(1);
      expect(backend.registrations[0]).toMatchObject({ redirect_uris: [redirect], application_type: "native", software_id: "@agenthooksprotocol/adapter-pi" });

      // The person follows it; the browser lands on pi's listener.
      const marker = world.ui.length;
      const landed = await fetch(await backend.consent(link));
      expect(landed.status).toBe(200);
      expect(await landed.text()).toContain("Signed in to org.example.protected");
      await world.until(() => world.uiOf("notify", marker).some((request) => request.message === "Signed in to org.example.protected."), "the sign-in notice");
      const widget = () => world.uiOf("setWidget", marker).filter((request) => request.widgetKey === "agent-hooks-protocol-login");
      await world.until(() => widget().length > 0, "the hint to clear");
      expect(widget().at(-1)).toMatchObject({ widgetKey: "agent-hooks-protocol-login" });
      expect(widget().at(-1)).not.toHaveProperty("widgetLines");

      await world.say("signed in");
      await world.until(() => backend.received.some((entry) => entry.type === "turn.start"), "an authorized delivery");
      const [token] = [...backend.issued];
      expect(backend.received.find((entry) => entry.type === "turn.start")?.authorization).toBe(`Bearer ${token}`);
      // Tokens and logins live in the 0600 store, never the registration secret file.
      const store = join(world.agent, "ahp-auth.json");
      expect(statSync(store).mode & 0o777).toBe(0o600);
      expect(readFileSync(store, "utf8")).toContain(token!);

      // Signed in: later turns show no link and prepare nothing.
      const quiet = world.ui.length;
      const lookups = backend.metadata.length;
      await world.say("still signed in");
      await world.say("and still");
      await Bun.sleep(300);
      expect(world.uiOf("setWidget", quiet)).toEqual([]);
      expect(world.uiOf("notify", quiet).filter((request) => String(request.message).includes("Sign in"))).toEqual([]);
      expect(backend.metadata.length).toBe(lookups);
      expect(readFileSync(store, "utf8")).not.toContain("pending_login");
      expect(backend.received.filter((entry) => entry.type === "turn.start").every((entry) => entry.authorization === `Bearer ${token}`)).toBe(true);
    } finally {
      await backend.stop();
    }
  }));

  test("OAuth: /ahp login takes a pasted redirect, /ahp status reports it, /ahp logout forgets it", () => inWorld(async (world) => {
    const backend = await protectedBackend();
    try {
      world.add(backend.backend());
      world.start({ NODE_EXTRA_CA_CERTS: certificate!.file, BROWSER: "none" });
      await world.until(() => world.responses.length > 0 || world.ui.length > 0 || world.received.length > 0, "pi to start");
      const marker = world.ui.length;
      world.send({ type: "prompt", message: "/ahp login org.example.protected" });
      await world.until(() => world.uiOf("input", marker).length > 0, "the paste box");
      const link = world.uiOf("setWidget", marker).at(-1)!.widgetLines[0].replace("Sign in to org.example.protected: ", "");
      // The browser could not reach pi: the person pastes where it ended up.
      world.send({ type: "extension_ui_response", id: world.uiOf("input", marker)[0]!.id, value: await backend.consent(link) });
      await world.until(() => world.uiOf("notify", marker).some((request) => request.message === "Signed in to org.example.protected."), "the sign-in");

      const status = world.ui.length;
      world.send({ type: "prompt", message: "/ahp status" });
      await world.until(() => world.uiOf("notify", status).some((request) => String(request.message).includes("org.example.protected: authorized")), "the status");
      expect(world.uiOf("notify", status).find((request) => String(request.message).includes("org.example.protected"))?.message).toContain("org.example.recorder: no sign-in needed");

      await world.say("signed in");
      await world.until(() => backend.received.some((entry) => entry.type === "turn.start"), "an authorized delivery");

      const out = world.ui.length;
      world.send({ type: "prompt", message: "/ahp logout org.example.protected" });
      await world.until(() => world.uiOf("notify", out).some((request) => request.message === "Signed out of org.example.protected."), "the sign-out");
      const before = backend.received.length;
      await world.say("signed out");
      expect(backend.received.slice(before).filter((entry) => entry.type === "turn.start")).toEqual([]);
    } finally {
      await backend.stop();
    }
  }));
  test("OAuth: a sign-in belongs to one backend: another on the same server still needs its own", () => inWorld(async (world) => {
    const backend = await protectedBackend();
    try {
      // One server and issuer: only the grant partition tells them apart.
      world.add(backend.backend("org.example.first"));
      world.add(backend.backend("org.example.second"));
      world.start({ NODE_EXTRA_CA_CERTS: certificate!.file, BROWSER: "none" });
      await world.until(() => world.received.length > 0, "pi to start");
      const marker = world.ui.length;
      world.send({ type: "prompt", message: "/ahp login org.example.first" });
      await world.until(() => world.uiOf("input", marker).length > 0, "the paste box");
      const link = world.uiOf("setWidget", marker).at(-1)!.widgetLines[0].replace("Sign in to org.example.first: ", "");
      world.send({ type: "extension_ui_response", id: world.uiOf("input", marker)[0]!.id, value: await backend.consent(link) });
      await world.until(() => world.uiOf("notify", marker).some((request) => request.message === "Signed in to org.example.first."), "the sign-in");

      await world.say("one of two");
      await world.until(() => backend.received.some((entry) => entry.type === "turn.end"), "the first backend's delivery");
      // One authorized delivery per event: the first's. The second sent nothing.
      expect(backend.received.filter((entry) => entry.type === "turn.start")).toHaveLength(1);
      const status = world.ui.length;
      world.send({ type: "prompt", message: "/ahp status" });
      await world.until(() => world.uiOf("notify", status).some((request) => String(request.message).includes("org.example.second: needs-login")), "the status");
      expect(world.uiOf("notify", status).find((request) => String(request.message).includes("org.example.second: needs-login"))?.message).toContain("org.example.first: authorized");
      // As in MCP clients, each sign-in registers its own client.
      expect(backend.registrations).toHaveLength(2);
    } finally {
      await backend.stop();
    }
  }));
  test("OAuth: two pis sign in on their own: each link is its owner's, and the grant is shared", () => inWorld(async (world) => {
    const backend = await protectedBackend();
    const env = { NODE_EXTRA_CA_CERTS: (await tls()).file, BROWSER: "none" };
    try {
      world.add(backend.backend());
      world.start(env);
      await world.until(() => world.received.length > 0, "pi to start");
      // A link shown on request, not after a failed delivery.
      const marker = world.ui.length;
      world.send({ type: "prompt", message: "/ahp status" });
      await world.until(() => world.uiOf("notify", marker).some((request) => String(request.message).includes("org.example.protected: needs-login")), "the status");
      const widget = () => world.uiOf("setWidget", marker).filter((request) => request.widgetKey === "agent-hooks-protocol-login");
      const mine = widget().at(-1)!.widgetLines[0].replace("Sign in to org.example.protected: ", "");

      const other = world.another(env);
      try {
        // The other pi makes its own sign-in, on its own port.
        other.send({ type: "prompt", message: "/ahp status" });
        await world.until(() => other.ui.some((request) => request.method === "notify" && String(request.message).includes("org.example.protected: needs-login")), "the other pi's status");
        const hint = () => other.ui.filter((request) => request.method === "setWidget" && request.widgetKey === "agent-hooks-protocol-login");
        const theirs = hint().at(-1)!.widgetLines[0].replace("Sign in to org.example.protected: ", "");
        const port = (link: string) => new URL(new URL(link).searchParams.get("redirect_uri")!).port;
        expect(theirs).not.toBe(mine);
        expect(port(theirs)).not.toBe(port(mine));
        expect(backend.registrations).toHaveLength(2);

        // A login completes only in the pi that owns it: this pi's redirect, sent to
        // the other's listener, is refused there and leaves this login usable.
        const redirect = new URL(await backend.consent(mine));
        const stray = new URL(redirect.pathname + redirect.search, `http://127.0.0.1:${port(theirs)}`);
        expect((await fetch(stray)).status).toBe(400);
        expect(backend.issued.size).toBe(0);

        // The person follows this pi's link: it signs in.
        const signed = world.ui.length;
        const landed = await fetch(await backend.consent(mine));
        expect(landed.status).toBe(200);
        await world.until(() => world.uiOf("notify", signed).some((request) => request.message === "Signed in to org.example.protected."), "this pi's sign-in");
        expect(backend.issued.size).toBe(1);

        // The other pi sees the shared grant at its next turn: its link goes, and its
        // delivery carries the token this pi got.
        const before = backend.received.length;
        other.send({ type: "prompt", message: "after the first signed in" });
        await world.until(() => hint().some((request) => !("widgetLines" in request)), "the other pi's link to clear");
        await world.until(() => backend.received.length > before, "the other pi's authorized delivery");
        expect(backend.received.at(-1)?.authorization).toBe(`Bearer ${[...backend.issued][0]}`);
        // Its own login was cancelled: its listener is gone.
        await expect(fetch(`http://127.0.0.1:${port(theirs)}/callback?state=x`)).rejects.toThrow();
      } finally {
        await other.stop();
      }
    } finally {
      await backend.stop();
    }
  }));
  test("OAuth: pi -p \"/ahp login\" prints the link once and stays until the redirect arrives", () => inWorld(async (world) => {
    const backend = await protectedBackend();
    try {
      world.add(backend.backend());
      const child = Bun.spawn(["node", cli, "-e", installed, "--provider", "fake", "--model", "m", "-p", "/ahp login org.example.protected"], {
        cwd: world.project,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
        env: { PATH: process.env.PATH!, HOME: world.home, PI_CODING_AGENT_DIR: world.agent, PI_OFFLINE: "1", AHP_HOOKS_FILE: join(world.dir, "hooks.json"), NODE_EXTRA_CA_CERTS: (await tls()).file, BROWSER: "none" },
      });
      let stderr = "";
      let exited = false;
      void child.exited.then(() => (exited = true));
      void (async () => {
        for await (const chunk of child.stderr as unknown as AsyncIterable<Uint8Array>) stderr += new TextDecoder().decode(chunk);
      })();
      const prefix = "Sign in to org.example.protected: ";
      await world.until(() => stderr.includes(prefix) || exited, "the printed link");
      const lines = stderr.split("\n").filter((line) => line.startsWith(prefix));
      // Printed once, not by both the notice and the sign-in.
      expect(lines).toHaveLength(1);
      // Nothing else holds pi open: the sign-in must, while the person signs in.
      await Bun.sleep(6000);
      expect(exited).toBe(false);
      const landed = await fetch(await backend.consent(lines[0]!.slice(prefix.length)));
      expect(landed.status).toBe(200);
      expect(await child.exited).toBe(0);
      expect(stderr).toContain("Signed in to org.example.protected.");
      expect(backend.issued.size).toBe(1);
    } finally {
      await backend.stop();
    }
  }));

  test("OAuth: a session that ends takes its links with it, so a later sign-out stays signed out", () => inWorld(async (world) => {
    const backend = await protectedBackend();
    try {
      world.add(backend.backend());
      world.start({ NODE_EXTRA_CA_CERTS: (await tls()).file, BROWSER: "none" });
      await world.until(() => world.received.length > 0, "pi to start");
      const link = async () => {
        const marker = world.ui.length;
        world.send({ type: "prompt", message: "/ahp status" });
        await world.until(() => world.uiOf("notify", marker).some((request) => String(request.message).includes("org.example.protected: needs-login")), "the status");
        return world.uiOf("setWidget", marker).filter((request) => request.widgetKey === "agent-hooks-protocol-login").at(-1)!.widgetLines[0].replace("Sign in to org.example.protected: ", "");
      };
      const old = await link();
      world.send({ type: "new_session" });
      await world.until(() => world.of("session.start").length === 2, "the new session");
      // The ended session's listener is gone: its link signs nobody in.
      await expect(fetch(await backend.consent(old))).rejects.toThrow();

      // The new session's own link, then a sign-out: that link is dead too.
      const fresh = await link();
      expect(fresh).not.toBe(old);
      const out = world.ui.length;
      world.send({ type: "prompt", message: "/ahp logout org.example.protected" });
      await world.until(() => world.uiOf("notify", out).some((request) => request.message === "Signed out of org.example.protected."), "the sign-out");
      await expect(fetch(await backend.consent(fresh))).rejects.toThrow();
      await expect(fetch(await backend.consent(old))).rejects.toThrow();
      expect(backend.issued.size).toBe(0);
      const status = world.ui.length;
      world.send({ type: "prompt", message: "/ahp status" });
      await world.until(() => world.uiOf("notify", status).some((request) => String(request.message).includes("org.example.protected: needs-login")), "the status after sign-out");
    } finally {
      await backend.stop();
    }
  }));
});
