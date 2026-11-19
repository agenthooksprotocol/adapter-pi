import { expect, test } from "bun:test";
import { receive } from "../../src/oauth/callback.ts";
import { backendAuth, trustedIssuer } from "../../src/oauth/settings.ts";
import { publicAddress } from "../../src/oauth/network.ts";

test("each sign-in listens on a port of its own, for its own login's redirect only", async () => {
  const seen: string[] = [];
  const a = await receive(async (url) => (seen.push(url), { ok: true, message: "Signed in to a." }));
  const b = await receive(async () => ({ ok: false, message: "b failed" }));
  expect(a.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  expect(b.redirectUri).not.toBe(a.redirectUri);
  // Before its login exists, nothing is accepted.
  expect((await fetch(`${a.redirectUri}?code=c&state=A`)).status).toBe(400);
  a.state = "A";
  b.state = "B";
  const ok = await fetch(`${a.redirectUri}?code=c&state=A`);
  expect(ok.status).toBe(200);
  expect(await ok.text()).toContain("Signed in to a.");
  expect(seen).toEqual([`${a.redirectUri}?code=c&state=A`]);
  // Another login's redirect, even this pi's own, is refused here.
  expect((await fetch(`${a.redirectUri}?code=c&state=B`)).status).toBe(400);
  expect((await fetch(`${b.redirectUri}?code=c&state=B`)).status).toBe(400);
  expect((await fetch(new URL("/elsewhere?state=A", a.redirectUri))).status).toBe(404);
  a.close();
  b.close();
  await expect(fetch(`${a.redirectUri}?state=A`)).rejects.toThrow();
  expect(seen).toHaveLength(1);
});

test("one callback per login: a repeat is answered neutrally, not as a failure", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const receiver = await receive(async () => {
    calls++;
    await gate;
    return { ok: true, message: "Signed in to a." };
  });
  receiver.state = "A";
  const first = fetch(`${receiver.redirectUri}?code=c&state=A`);
  await Bun.sleep(50);
  // A second request while the first is handled, and another after it.
  const during = await fetch(`${receiver.redirectUri}?code=c&state=A`);
  release();
  expect((await first).status).toBe(200);
  const after = await fetch(`${receiver.redirectUri}?code=c&state=A`);
  for (const repeat of [during, after]) {
    expect(repeat.status).toBe(200);
    expect(await repeat.text()).toContain("already received");
  }
  expect(calls).toBe(1);
  // A handler that leaves the login waiting takes the next one.
  receiver.state = "A";
  expect((await fetch(`${receiver.redirectUri}?code=d&state=A`)).status).toBe(200);
  expect(calls).toBe(2);
  receiver.close();
});

test("settings: registration only for a named issuer, and no fixed redirect port", () => {
  const base = { id: "org.example.a", transport: { type: "http", url: "https://h.example/ahp" } };
  const unnamed = backendAuth({ ...base, oauth: { registration: true } });
  expect(unnamed.auth.settings.registration).toBeUndefined();
  expect(unnamed.problems).toEqual(["org.example.a: oauth.registration needs oauth.issuer; ignored"]);
  const named = backendAuth({
    ...base,
    oauth: { issuer: "https://auth.example", registration: true, loginLifetimeMinutes: 2 },
    subscriptions: [{ mode: "observe", events: ["*"], content: { default: "body" }, upload: { endpoint: "https://h.example/content", timeoutMs: 1, maxBytes: 1 } }],
  });
  expect(named.problems).toEqual([]);
  expect(named.auth.settings).toMatchObject({ issuer: "https://auth.example", registration: {}, loginLifetimeMs: 120_000 });
  expect(named.auth.endpoints.map((endpoint) => endpoint.purpose)).toEqual(["event", "upload"]);
  expect(backendAuth({ ...base, oauth: { loginLifetimeMinutes: 60 } }).problems).toHaveLength(1);
  // Each sign-in picks its own port: a configured one is said to be ignored.
  const ported = backendAuth({ ...base, oauth: { redirectPort: 40001 } });
  expect(ported.problems).toEqual(["org.example.a: oauth.redirectPort is no longer used: each sign-in picks its own port; ignored"]);
  expect(ported.auth.settings).not.toHaveProperty("redirectPort");
  expect(backendAuth({ ...base, transport: { ...base.transport, headers: { Authorization: { env: "X" } } } }).auth.headerAuthorization).toBe(true);
});

test("only public addresses, unless a backend allows its private network", () => {
  for (const address of ["8.8.8.8", "2606:4700::1111", "::ffff:1.1.1.1", "::ffff:808:808", "[2a00:1450::1]"]) expect(publicAddress(address)).toBe(true);
  for (const address of [
    "127.0.0.1", "10.0.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "255.255.255.255", "198.18.0.1",
    "::1", "::", "fd00::1", "fe80::1", "ff02::1",
    // IPv4-mapped, in every spelling a URL parser or resolver gives.
    "::ffff:127.0.0.1", "::ffff:7f00:1", "[::ffff:7f00:1]", "::ffff:a00:1", "0:0:0:0:0:ffff:7f00:1", "::ffff:0:a9fe:a9fe",
    // NAT64, 6to4, Teredo, documentation, IPv4-compatible.
    "64:ff9b::7f00:1", "64:ff9b:1::1", "2002:7f00:1::1", "2001:0:4136:e378::1", "2001:db8::1", "2001:0db8::1", "3fff::1", "::127.0.0.1",
    "localhost", "not an address",
  ]) expect(publicAddress(address)).toBe(false);
  // The URL parser's spelling of a mapped loopback literal is refused too.
  expect(publicAddress(new URL("https://[::ffff:127.0.0.1]/").hostname)).toBe(false);
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
