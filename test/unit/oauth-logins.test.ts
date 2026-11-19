// The logins against the real SDK and an in-process authorization server: the
// network policy is replaced so requests reach it without TLS or sockets.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthError } from "agenthooksprotocol/client";
import { Logins, type LoginHost } from "../../src/oauth/index.ts";

const root = mkdtempSync(join(tmpdir(), "ahp-pi-logins-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ISSUER = "https://as.test";
const ID = "org.example.protected";

/** An authorization server and protected resource in one origin. `granted` is
 * the scope the token endpoint grants. */
function server() {
  const codes = new Set<string>();
  const state = { granted: "hooks admin", registrations: 0 };
  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === "/.well-known/oauth-protected-resource/ahp") return Response.json({ resource: `${ISSUER}/ahp`, authorization_servers: [ISSUER] });
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        registration_endpoint: `${ISSUER}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        authorization_response_iss_parameter_supported: true,
      });
    }
    if (url.pathname === "/register" && request.method === "POST") {
      const metadata = (await request.json()) as Record<string, unknown>;
      return Response.json({ ...metadata, client_id: `client-${++state.registrations}`, token_endpoint_auth_method: "none" }, { status: 201 });
    }
    if (url.pathname === "/token" && request.method === "POST") {
      const form = new URLSearchParams(await request.text());
      if (!codes.delete(form.get("code") ?? "")) return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({ access_token: `token-${crypto.randomUUID()}`, token_type: "Bearer", expires_in: 3600, scope: state.granted });
    }
    return new Response("not found", { status: 404 });
  };
  return {
    state,
    network: () => ({
      checkDestination: async () => {},
      policyFetch: (target: string, init: RequestInit) => handle(new Request(target, init)),
    }),
    /** What a browser does with the link: the address it is sent back to. */
    consent(link: string): string {
      const authorize = new URL(link);
      const code = crypto.randomUUID();
      codes.add(code);
      const back = new URL(authorize.searchParams.get("redirect_uri")!);
      back.searchParams.set("code", code);
      back.searchParams.set("state", authorize.searchParams.get("state")!);
      back.searchParams.set("iss", ISSUER);
      return back.href;
    },
  };
}

class Host implements LoginHost {
  hasUI = true;
  readonly notes: string[] = [];
  lines: string[] | undefined;
  readonly prompts: ((value: string | undefined) => void)[] = [];
  onOpen: (url: string) => void = () => {};
  notify(text: string): void {
    this.notes.push(text);
  }
  widget(lines: string[] | undefined): void {
    this.lines = lines;
  }
  input(_title: string, _placeholder: string, signal: AbortSignal): Promise<string | undefined> {
    return new Promise((resolve) => {
      this.prompts.push(resolve);
      signal.addEventListener("abort", () => resolve(undefined), { once: true });
    });
  }
  open(url: string): void {
    this.onOpen(url);
  }
  log(): void {}
  link(): string | undefined {
    return this.lines?.[0]?.replace(`Sign in to ${ID}: `, "");
  }
}

async function until(check: () => unknown, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

function setup(scopes: string[] | undefined = ["hooks", "admin"], extra: Record<string, unknown> = {}) {
  const as = server();
  const host = new Host();
  const backend = {
    id: ID,
    transport: { type: "http", url: `${ISSUER}/ahp` },
    oauth: { issuer: ISSUER, registration: true, ...(scopes ? { scopes } : {}) },
    subscriptions: [{ mode: "observe", events: ["*"], content: { default: "body" } }],
    ...extra,
  };
  const logins = new Logins(host, mkdtempSync(join(root, "agent-")), [backend], { network: as.network });
  return { as, host, logins };
}

const redirectOf = (link: string) => new URL(link).searchParams.get("redirect_uri")!;
const stateOf = (link: string) => new URL(link).searchParams.get("state")!;
const login = { code: "interaction_required", recovery: "login" } as const;

test("a step-up replaces a sign-in already showing, whose login could not grant it", async () => {
  const { as, host, logins } = setup();
  logins.observe(ID, login);
  logins.turnStart();
  await until(() => host.link(), "the first link");
  const first = host.link()!;
  logins.observe(ID, { ...login, requiredScopes: ["admin"] });
  logins.turnStart();
  await until(() => host.link() && host.link() !== first, "a link for the step-up");
  // The first login has ended: its listener is gone.
  await expect(fetch(as.consent(first))).rejects.toThrow();
  // The new one asks for admin: a grant without it does not complete it.
  as.state.granted = "hooks";
  const narrow = await fetch(as.consent(host.link()!));
  expect(narrow.status).toBe(400);
  await logins.close();
});

test("a later failure that names no scopes keeps the step-up's scopes", async () => {
  const { as, host, logins } = setup();
  logins.observe(ID, { ...login, requiredScopes: ["admin"] });
  logins.turnStart();
  await until(() => host.link(), "the step-up link");
  logins.observe(ID, login);
  // The person refuses consent: the SDK uses up the login, which ends.
  const link = host.link()!;
  const denied = await fetch(`${redirectOf(link)}?error=access_denied&state=${stateOf(link)}&iss=${encodeURIComponent(ISSUER)}`);
  expect(denied.status).toBe(400);
  await until(() => !host.link(), "the refused login to end");
  // The next login still needs admin.
  logins.turnStart();
  await until(() => host.link(), "another link");
  as.state.granted = "hooks";
  expect((await fetch(as.consent(host.link()!))).status).toBe(400);
  await until(() => !host.link(), "the narrow sign-in to end");
  logins.turnStart();
  await until(() => host.link(), "a third link");
  as.state.granted = "hooks admin";
  expect((await fetch(as.consent(host.link()!))).status).toBe(200);
  expect(host.notes).toContain(`Signed in to ${ID}.`);
  await logins.close();
});

test("a bad paste or a stray callback leaves the login waiting", async () => {
  const { as, host, logins } = setup();
  const done = logins.command(`login ${ID}`);
  await until(() => host.prompts.length === 1, "the paste box");
  const link = host.link()!;
  // The sign-in link itself, pasted by mistake: refused before the SDK sees it.
  host.prompts[0]!(link);
  await until(() => host.prompts.length === 2, "the paste box again");
  expect(host.notes.some((note) => note.startsWith("That is not where the browser ended."))).toBe(true);
  expect(host.link()).toBe(link);
  // The right address, with its state but another issuer: the SDK refuses it
  // without using the login.
  const forged = `${redirectOf(link)}?code=x&state=${stateOf(link)}&iss=${encodeURIComponent("https://evil.test")}`;
  host.prompts[1]!(forged);
  await until(() => host.prompts.length === 3, "the paste box a third time");
  expect(host.notes.at(-1)).toContain("Its link still works.");
  expect(host.link()).toBe(link);
  // The same, sent to the listener: refused, and it still listens.
  const stray = await fetch(forged);
  expect(stray.status).toBe(400);
  expect(await stray.text()).toContain("still waiting");
  // The real redirect signs in.
  host.prompts[2]!(as.consent(link));
  await done;
  expect(host.notes.at(-1)).toBe(`Signed in to ${ID}.`);
  expect(host.link()).toBeUndefined();
});

test("/ahp login returns when its login ended before it began to wait", async () => {
  const { host, logins } = setup();
  host.hasUI = false;
  // The login ends between being prepared and the sign-in waiting on it.
  host.onOpen = () => void logins.command(`logout ${ID}`);
  const finished = await Promise.race([logins.command(`login ${ID}`).then(() => true), Bun.sleep(3000).then(() => false)]);
  expect(finished).toBe(true);
});

/** Sign in through /ahp login and a pasted redirect. */
async function signIn(as: ReturnType<typeof server>, host: Host, logins: Logins): Promise<void> {
  const done = logins.command(`login ${ID}`);
  await until(() => host.prompts.length, "the paste box");
  host.prompts.shift()!(as.consent(host.link()!));
  await done;
  expect(host.notes.at(-1)).toBe(`Signed in to ${ID}.`);
}

test("completing an older login keeps the step-up scopes it did not cover", async () => {
  const { as, host, logins } = setup();
  logins.observe(ID, login);
  logins.turnStart();
  await until(() => host.link(), "the first link");
  // A step-up arrives while the first link shows; the person then finishes it.
  logins.observe(ID, { ...login, requiredScopes: ["admin"] });
  as.state.granted = "hooks";
  expect((await fetch(as.consent(host.link()!))).status).toBe(200);
  expect(host.link()).toBeUndefined();
  // admin is still needed: the next turn shows a login for it.
  logins.turnStart();
  await until(() => host.link(), "a link for the step-up");
  await logins.close();
});

test("a step-up the SDK refuses beyond the allowed scopes says so, even when signed in", async () => {
  const { as, host, logins } = setup(["hooks"]);
  await signIn(as, host, logins);
  // What the SDK's challenge gives for 403 insufficient_scope scope="hooks root".
  logins.observe(ID, { code: "access_denied", recovery: "none", requiredScopes: ["hooks", "root"] });
  await logins.command(`status ${ID}`);
  expect(host.notes.at(-1)).toContain(`${ID}: authorized, but refused`);
  // Only the scope outside oauth.scopes is named.
  expect(host.notes.at(-1)).toContain("not allowed: root;");
  // The status found the grant ready, which clears it; the next refusal sets it again.
  logins.observe(ID, { code: "access_denied", recovery: "none", requiredScopes: ["root"] });
  await logins.command(`login ${ID}`);
  expect(host.notes.at(-1)).toContain("not allowed: root;");
  expect(host.notes.at(-1)).not.toContain("already signed in");
  expect(host.notes.at(-1)).not.toContain("not trusted");
});

const refused = { code: "access_denied", recovery: "none", requiredScopes: ["root"] } as const;

test("a refusal is forgotten once a grant is found ready, or an access_denied names no scopes", async () => {
  const { as, host, logins } = setup(["hooks"]);
  await signIn(as, host, logins);
  logins.observe(ID, refused);
  await logins.command(`status ${ID}`);
  expect(host.notes.at(-1)).toContain("not allowed: root;");
  await logins.command(`status ${ID}`);
  expect(host.notes.at(-1)).toBe(`${ID}: authorized`);
  logins.observe(ID, refused);
  logins.observe(ID, { code: "access_denied", recovery: "none" });
  await logins.command(`status ${ID}`);
  expect(host.notes.at(-1)).toBe(`${ID}: authorized`);
});

test("a completed sign-in forgets a refusal", async () => {
  const { as, host, logins } = setup(["hooks"]);
  logins.observe(ID, refused);
  await signIn(as, host, logins);
  await logins.command(`status ${ID}`);
  expect(host.notes.at(-1)).toBe(`${ID}: authorized`);
});

test("the allowed scopes are every endpoint's when oauth.scopes is not set", async () => {
  // A pre-registered client, named by each endpoint's binding.
  const { as, host, logins } = setup(undefined, {
    oauth: {},
    authentication: { type: "oauth", flow: "authorization_code_pkce", issuer: ISSUER, resource: `${ISSUER}/ahp`, clientId: "pi", scopes: ["hooks"] },
    subscriptions: [{ mode: "observe", events: ["*"], content: { default: "body" }, upload: { endpoint: `${ISSUER}/content`, timeoutMs: 1000, maxBytes: 1000, auth: { type: "oauth", flow: "authorization_code_pkce", issuer: ISSUER, resource: `${ISSUER}/content`, clientId: "pi", scopes: ["uploads"] } } }],
  });
  await signIn(as, host, logins);
  logins.observe(ID, { code: "access_denied", recovery: "none", requiredScopes: ["uploads", "root"] });
  await logins.command(`status ${ID}`);
  expect(host.notes.at(-1)).toContain("not allowed: root;");
});

test("bare /ahp login reports a refusal without adding that nothing needs a sign-in", async () => {
  const { as, host, logins } = setup(["hooks"]);
  await signIn(as, host, logins);
  logins.observe(ID, refused);
  const before = host.notes.length;
  await logins.command("login");
  const said = host.notes.slice(before);
  expect(said).toHaveLength(1);
  expect(said[0]).toContain("not allowed: root;");
});

test("the SDK's own refusal of a step-up beyond the allowed scopes names them", async () => {
  const { as, host, logins } = setup(["hooks"]);
  await signIn(as, host, logins);
  // A delivery answered 403 insufficient_scope for a scope oauth.scopes lacks.
  const refuse = async () => {
    const response = new Response(null, { status: 403, headers: { "www-authenticate": 'Bearer error="insufficient_scope", scope="root"' } });
    const error = await Promise.resolve(logins.provider.challenge({ backendId: ID, purpose: "event", url: `${ISSUER}/ahp`, response, credential: undefined })).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(AuthError);
    const { code, recovery, requiredScopes } = error as AuthError;
    expect(code).toBe("access_denied");
    expect(requiredScopes).toEqual(["root"]);
    logins.observe(ID, { code, recovery, ...(requiredScopes ? { requiredScopes } : {}) });
  };
  await refuse();
  await logins.command(`status ${ID}`);
  expect(host.notes.at(-1)).toContain(`${ID}: authorized, but refused`);
  expect(host.notes.at(-1)).toContain("not allowed: root;");
  await refuse();
  await logins.command(`login ${ID}`);
  expect(host.notes.at(-1)).toContain("not allowed: root;");
  expect(host.notes.at(-1)).not.toContain("already signed in");
});

test("a refusal naming only allowed scopes names none", async () => {
  const { as, host, logins } = setup(["hooks"]);
  await signIn(as, host, logins);
  logins.observe(ID, { code: "access_denied", recovery: "none", requiredScopes: ["hooks"] });
  await logins.command(`status ${ID}`);
  expect(host.notes.at(-1)).toBe(`${ID}: authorized`);
  await logins.command(`login ${ID}`);
  expect(host.notes.at(-1)).toContain("already signed in");
});

test("a login asked for scopes beyond the allowed ones says so, not that the issuer is untrusted", async () => {
  const { host, logins } = setup(["hooks"]);
  logins.observe(ID, { ...login, requiredScopes: ["root"] });
  await logins.command(`login ${ID}`);
  const note = host.notes.find((text) => text.startsWith(`${ID} cannot sign in: access_denied`));
  expect(note).toContain("not allowed: root");
  expect(note).not.toContain("not trusted");
});
