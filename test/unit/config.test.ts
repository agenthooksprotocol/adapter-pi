import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMcpServers, loadRegistration, projectDecided, registrationPaths } from "../../src/config.ts";
import { connection } from "../../src/mcp.ts";

const root = mkdtempSync(join(tmpdir(), "ahp-pi-config-"));
const home = join(root, "home");
const cwd = join(root, "project");
const backend = (id: string, url: string) => ({ id, transport: { type: "http", url } });
const write = (path: string, hooks: unknown[]) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ protocolVersion: "draft", hooks }));
};
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("paths run from the user to the project, pi's directory beating .agents", () => {
  expect(registrationPaths({ HOME: "/h" }, "/p").map((source) => source.path)).toEqual([
    "/h/.agents/hooks.json",
    "/h/.pi/agent/hooks.json",
    "/p/.agents/hooks.json",
    "/p/.pi/hooks.json",
  ]);
  expect(registrationPaths({ HOME: "/h", PI_CODING_AGENT_DIR: "/a" }, "/p")[1]?.path).toBe("/a/hooks.json");
});

test("a home directory is not also a project", () => {
  expect(registrationPaths({ HOME: "/h" }, "/h").map((source) => source.scope)).toEqual(["user", "user"]);
});

test("a later file replaces a backend with the same id", () => {
  write(join(home, ".agents/hooks.json"), [backend("a", "http://user/"), backend("b", "http://user/")]);
  write(join(cwd, ".pi/hooks.json"), [backend("a", "http://project/")]);
  const { registration, notes } = loadRegistration({ HOME: home }, cwd, true);
  expect(registration?.hooks.map((hook) => [hook.id, (hook.transport as { url: string }).url])).toEqual([["a", "http://project/"], ["b", "http://user/"]]);
  expect(notes.join()).toContain("replaces");
});

test("an untrusted project contributes nothing", () => {
  const { registration, diagnostics, untrusted } = loadRegistration({ HOME: home }, cwd, false);
  expect(registration?.hooks.map((hook) => (hook.transport as { url: string }).url)).toEqual(["http://user/", "http://user/"]);
  expect(untrusted).toEqual([join(cwd, ".pi/hooks.json")]);
  expect(diagnostics).toEqual([]);
});

test("a pinned file replaces discovery, trust or not", () => {
  const pinned = join(root, "pinned.json");
  write(pinned, [backend("only", "http://pinned/")]);
  const { registration, sources } = loadRegistration({ HOME: home, AHP_HOOKS_FILE: pinned }, cwd, false);
  expect(registration?.hooks.map((hook) => hook.id)).toEqual(["only"]);
  expect(sources).toHaveLength(1);
});

test("a broken file is skipped with a diagnostic", () => {
  const bad = join(root, "bad");
  mkdirSync(join(bad, ".agents"), { recursive: true });
  writeFileSync(join(bad, ".agents/hooks.json"), "{nope");
  const other = join(root, "other");
  mkdirSync(join(other, ".agents"), { recursive: true });
  writeFileSync(join(other, ".agents/hooks.json"), JSON.stringify({ hooks: [] }));
  expect(loadRegistration({ HOME: bad }, cwd, false).diagnostics[0]).toContain("not JSON");
  expect(loadRegistration({ HOME: other }, cwd, false).diagnostics[0]).toContain("not an AHP");
  expect(loadRegistration({ HOME: bad }, cwd, false).registration).toBeUndefined();
});

test("a project's MCP servers count only when it is trusted", () => {
  const agent = join(root, "agent");
  mkdirSync(agent, { recursive: true });
  writeFileSync(join(agent, "mcp.json"), JSON.stringify({ mcpServers: { docs: { command: "a" } } }));
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi/mcp.json"), JSON.stringify({ mcpServers: { docs: { url: "http://x/" }, more: { command: "b" } } }));
  expect([...loadMcpServers({ PI_CODING_AGENT_DIR: agent }, cwd, false).keys()]).toEqual(["docs"]);
  expect(loadMcpServers({ PI_CODING_AGENT_DIR: agent }, cwd, true).get("docs")?.url).toBe("http://x/");
});

test("an MCP connection carries no credential", () => {
  expect(connection({ url: "https://user:secret@example.com/mcp?token=abc", headers: { Authorization: "x" } })).toEqual({ transport: "http", url: "https://example.com/mcp" });
  const stdio = connection({ command: "tool", args: ["--token", "abc"], env: { KEY: "x" } });
  expect(JSON.stringify(stdio)).not.toContain("abc");
  expect(stdio.transport).toBe("stdio");
  expect(connection(undefined).transport).toBe("unknown");
});

test("pi's trust alone does not admit a project's registration: it takes a decision", () => {
  const project = join(root, "decided/sub");
  const agent = join(root, "decided-agent");
  mkdirSync(join(project, ".pi"), { recursive: true });
  mkdirSync(agent, { recursive: true });
  const decided = (overrides: Partial<Parameters<typeof projectDecided>[0]> = {}) =>
    projectDecided({ environment: { PI_CODING_AGENT_DIR: agent }, cwd: project, trusted: true, argv: [], defaultProjectTrust: "ask", ...overrides });

  // What a repository holding only a hooks.json looks like to pi.
  writeFileSync(join(project, ".pi/hooks.json"), "{}");
  expect(decided()).toBe(false);
  expect(decided({ argv: ["node", "pi", "--approve"] })).toBe(true);
  expect(decided({ defaultProjectTrust: "always" })).toBe(true);

  // The nearest saved decision, as pi reads it.
  writeFileSync(join(agent, "trust.json"), JSON.stringify({ [join(root, "decided")]: true }));
  expect(decided()).toBe(true);
  writeFileSync(join(agent, "trust.json"), JSON.stringify({ [join(root, "decided")]: true, [project]: false }));
  expect(decided()).toBe(false);
  rmSync(join(agent, "trust.json"));

  // pi asked about a resource of its own.
  writeFileSync(join(project, ".pi/settings.json"), "{}");
  expect(decided()).toBe(true);

  // Refused stays refused, whatever else holds.
  expect(decided({ trusted: false, argv: ["--approve"], defaultProjectTrust: "always" })).toBe(false);
});
