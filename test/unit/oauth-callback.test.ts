import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { close, listening, receive, redirectUri, RETRY_MS } from "../../src/oauth/callback.ts";
import { backendAuth, defaultPort, trustedIssuer } from "../../src/oauth/settings.ts";
import { publicAddress } from "../../src/oauth/network.ts";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("a redirect reaches the login it belongs to, and only that one", async () => {
  const port = await freePort();
  const seen: string[] = [];
  expect(await receive(port, Date.now() + 10_000, "a", async (url) => (new URL(url).searchParams.get("state") === "A" ? (seen.push(url), { ok: true, message: "Signed in to a." }) : undefined))).toBe(true);
  // A second backend on the same port shares the listener.
  expect(await receive(port, Date.now() + 10_000, "b", async (url) => (new URL(url).searchParams.get("state") === "B" ? { ok: false, message: "b failed" } : undefined))).toBe(true);
  const ok = await fetch(`${redirectUri(port)}?code=c&state=A`);
  expect(ok.status).toBe(200);
  expect(await ok.text()).toContain("Signed in to a.");
  expect(seen).toEqual([`${redirectUri(port)}?code=c&state=A`]);
  expect((await fetch(`${redirectUri(port)}?code=c&state=B`)).status).toBe(400);
  expect((await fetch(`${redirectUri(port)}?code=c&state=nobody`)).status).toBe(400);
  expect((await fetch(`http://127.0.0.1:${port}/elsewhere?state=A`)).status).toBe(404);
  close(port);
  expect(listening(port)).toBe(false);
});

test("a port another process holds is left to it, and taken over once it goes", async () => {
  const port = await freePort();
  const other = createServer();
  await new Promise<void>((resolve) => other.listen(port, "127.0.0.1", resolve));
  expect(await receive(port, Date.now() + 10_000, "a", async () => ({ ok: true, message: "taken over" }))).toBe(false);
  expect(listening(port)).toBe(false);
  await new Promise((resolve) => other.close(resolve));
  await Bun.sleep(RETRY_MS + 500);
  expect(listening(port)).toBe(true);
  expect(await (await fetch(`${redirectUri(port)}?state=x`)).text()).toContain("taken over");
  close(port);
});

test("a taken port is not retried past the login's expiry", async () => {
  const port = await freePort();
  const other = createServer();
  await new Promise<void>((resolve) => other.listen(port, "127.0.0.1", resolve));
  expect(await receive(port, Date.now() + RETRY_MS / 2, "a", async () => undefined)).toBe(false);
  await new Promise((resolve) => other.close(resolve));
  await Bun.sleep(RETRY_MS + 500);
  expect(listening(port)).toBe(false);
});

test("the listener stops when the last login it serves expires", async () => {
  const port = await freePort();
  await receive(port, Date.now() + 100, "a", async () => undefined);
  await receive(port, Date.now() + 300, "b", async () => undefined);
  await Bun.sleep(200);
  expect(listening(port)).toBe(true);
  await Bun.sleep(250);
  expect(listening(port)).toBe(false);
});

test("settings: a stable port per backend, and registration only for a named issuer", () => {
  expect(defaultPort("org.example.a")).toBe(defaultPort("org.example.a"));
  expect(defaultPort("org.example.a")).toBeGreaterThanOrEqual(20000);
  const base = { id: "org.example.a", transport: { type: "http", url: "https://h.example/ahp" } };
  const unnamed = backendAuth({ ...base, oauth: { registration: true } });
  expect(unnamed.auth.settings.registration).toBeUndefined();
  expect(unnamed.problems).toEqual(["org.example.a: oauth.registration needs oauth.issuer; ignored"]);
  const named = backendAuth({
    ...base,
    oauth: { issuer: "https://auth.example", registration: true, redirectPort: 40001, loginLifetimeMinutes: 2 },
    subscriptions: [{ mode: "observe", events: ["*"], content: { default: "body" }, upload: { endpoint: "https://h.example/content", timeoutMs: 1, maxBytes: 1 } }],
  });
  expect(named.problems).toEqual([]);
  expect(named.auth.settings).toMatchObject({ issuer: "https://auth.example", registration: {}, redirectPort: 40001, loginLifetimeMs: 120_000 });
  expect(named.auth.redirectUri).toBe("http://127.0.0.1:40001/callback");
  expect(named.auth.endpoints.map((endpoint) => endpoint.purpose)).toEqual(["event", "upload"]);
  expect(backendAuth({ ...base, oauth: { redirectPort: 80, loginLifetimeMinutes: 60 } }).problems).toHaveLength(2);
  expect(backendAuth({ ...base, transport: { ...base.transport, headers: { Authorization: { env: "X" } } } }).auth.headerAuthorization).toBe(true);
});

test("only public addresses, unless a backend allows its private network", () => {
  for (const address of ["8.8.8.8", "2606:4700::1111", "::ffff:1.1.1.1"]) expect(publicAddress(address)).toBe(true);
  for (const address of ["127.0.0.1", "10.0.0.1", "192.168.1.1", "169.254.169.254", "::1", "fd00::1", "::ffff:127.0.0.1", "100.64.0.1"]) expect(publicAddress(address)).toBe(false);
});

test("an advertised issuer is trusted only by opt-in, for a public browser sign-in", () => {
  const pkce = { flow: "authorization_code_pkce" as const, confidential: false, advertised: ["https://as.example"] };
  expect(trustedIssuer({ ...pkce, configured: undefined, trustAdvertised: false })).toBeUndefined();
  expect(trustedIssuer({ ...pkce, configured: undefined, trustAdvertised: true })).toBe("https://as.example");
  expect(trustedIssuer({ ...pkce, configured: undefined, trustAdvertised: true, confidential: true })).toBeUndefined();
  expect(trustedIssuer({ ...pkce, configured: undefined, trustAdvertised: true, flow: "client_credentials" })).toBeUndefined();
  expect(trustedIssuer({ ...pkce, configured: undefined, trustAdvertised: true, advertised: ["https://a.example", "https://b.example"] })).toBeUndefined();
  expect(trustedIssuer({ ...pkce, configured: "https://as.example", trustAdvertised: false, confidential: true })).toBe("https://as.example");
  expect(trustedIssuer({ ...pkce, configured: "https://other.example", trustAdvertised: true })).toBeUndefined();
  expect(backendAuth({ id: "a", transport: { type: "http", url: "https://h.example" }, oauth: { trustAdvertisedIssuer: true } }).auth.settings.trustAdvertisedIssuer).toBe(true);
});
