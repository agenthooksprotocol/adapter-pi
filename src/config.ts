// Registration discovery: `hooks.json` under `.agents/` and pi's own directories,
// for the user and for the project, merged into one AHP registration document.
//
// A project's files count only once someone has decided to trust the project: a
// registration names where session content goes, so a cloned repository must not
// be able to choose that by shipping one. See `projectDecided`.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface RegistrationSource {
  /** Absolute path of the file. */
  path: string;
  scope: "user" | "project";
}

export interface LoadedRegistration {
  /** The merged registration, or undefined when no file declares a backend. */
  registration?: { protocolVersion: "draft"; hooks: Record<string, unknown>[] };
  /** The files that contributed, lowest precedence first. */
  sources: RegistrationSource[];
  /** Files or backends skipped: a person should know a policy may not be running. */
  diagnostics: string[];
  /** Backends replaced by a more specific file: normal, and detail. */
  notes: string[];
  /** A project's registrations that were left out until it is trusted. */
  untrusted: string[];
}

export type Environment = Record<string, string | undefined>;

/** pi's directory for this user. */
export function agentDir(environment: Environment): string | undefined {
  return environment.PI_CODING_AGENT_DIR ?? (environment.HOME ? join(environment.HOME, ".pi/agent") : undefined);
}

/** Lowest precedence first: a later file's backend replaces an earlier one with
 * the same `id`, so the project beats the user, and pi's directory beats
 * `.agents` within each. */
export function registrationPaths(environment: Environment, cwd: string): RegistrationSource[] {
  const home = environment.HOME;
  const paths: RegistrationSource[] = [];
  if (home) paths.push({ path: join(home, ".agents/hooks.json"), scope: "user" });
  const agent = agentDir(environment);
  if (agent) paths.push({ path: join(agent, "hooks.json"), scope: "user" });
  if (cwd !== home) {
    paths.push({ path: join(cwd, ".agents/hooks.json"), scope: "project" });
    paths.push({ path: join(cwd, ".pi/hooks.json"), scope: "project" });
  }
  return paths;
}

/** What makes pi ask about a project, under `.pi`: a true answer from
 * isProjectTrusted means a decision only where one of these exists. */
const PROTECTED = ["settings.json", "mcp.json", "extensions", "skills", "prompts", "themes", "SYSTEM.md", "APPEND_SYSTEM.md"];

/** The nearest saved decision for a directory, as pi looks it up. */
function savedDecision(file: string, cwd: string): boolean | undefined {
  let decisions: Record<string, unknown>;
  try {
    decisions = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  for (let directory = resolve(cwd); ; directory = dirname(directory)) {
    const decision = decisions[directory];
    if (typeof decision === "boolean") return decision;
    if (dirname(directory) === directory) return undefined;
  }
}

/** Whether a project's registrations may count. pi's isProjectTrusted answers true
 * for any directory holding nothing pi itself protects, and a `hooks.json` is not
 * something it knows about: that answer alone would let a repository with only a
 * `.pi/hooks.json` send its reader's session anywhere. So it must rest on a
 * decision: a saved one, the flag, the setting, or the question pi asked. */
export function projectDecided(options: { environment: Environment; cwd: string; trusted: boolean; argv: readonly string[]; defaultProjectTrust: string | undefined }): boolean {
  const { environment, cwd, trusted, argv, defaultProjectTrust } = options;
  if (!trusted) return false;
  if (argv.includes("--approve") || argv.includes("-a") || defaultProjectTrust === "always") return true;
  const agent = agentDir(environment);
  if (agent && savedDecision(join(agent, "trust.json"), cwd) === true) return true;
  return PROTECTED.some((name) => existsSync(join(cwd, ".pi", name)));
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Read and merge every registration file that exists. Structural validation of
 * the result is the SDK's: this only keeps files from poisoning each other. */
export function loadRegistration(environment: Environment, cwd: string, trusted: boolean): LoadedRegistration {
  // One explicit file replaces discovery (tests, CI, a pinned deployment).
  const pinned = environment.AHP_HOOKS_FILE;
  const paths = pinned ? [{ path: pinned, scope: "user" as const }] : registrationPaths(environment, cwd);
  const diagnostics: string[] = [];
  const notes: string[] = [];
  const untrusted: string[] = [];
  const sources: RegistrationSource[] = [];
  const backends = new Map<string, { backend: Record<string, unknown>; path: string }>();
  for (const source of paths) {
    if (!existsSync(source.path)) continue;
    if (source.scope === "project" && !trusted) {
      untrusted.push(source.path);
      continue;
    }
    let document: unknown;
    try {
      document = JSON.parse(readFileSync(source.path, "utf8"));
    } catch (error) {
      diagnostics.push(`${source.path}: unreadable or not JSON (${error instanceof SyntaxError ? "syntax error" : String(error)}); skipped`);
      continue;
    }
    if (!object(document) || document.protocolVersion !== "draft" || !Array.isArray(document.hooks)) {
      diagnostics.push(`${source.path}: not an AHP draft registration (protocolVersion "draft", hooks[]); skipped`);
      continue;
    }
    sources.push(source);
    for (const backend of document.hooks) {
      if (!object(backend) || typeof backend.id !== "string") {
        diagnostics.push(`${source.path}: a backend without an id; skipped`);
        continue;
      }
      const previous = backends.get(backend.id);
      if (previous) notes.push(`${backend.id}: ${source.path} replaces ${previous.path}`);
      backends.set(backend.id, { backend, path: source.path });
    }
  }
  if (backends.size === 0) return { sources, diagnostics, notes, untrusted };
  return {
    registration: { protocolVersion: "draft", hooks: [...backends.values()].map(({ backend }) => backend) },
    sources,
    diagnostics,
    notes,
    untrusted,
  };
}

/** MCP servers as pi configures them, by name: the project's replace the user's. */
export function loadMcpServers(environment: Environment, cwd: string, trusted: boolean): Map<string, Record<string, unknown>> {
  const servers = new Map<string, Record<string, unknown>>();
  const agent = agentDir(environment);
  const files = [...(agent ? [join(agent, "mcp.json")] : []), ...(trusted ? [join(cwd, ".pi/mcp.json")] : [])];
  for (const file of files) {
    if (!existsSync(file)) continue;
    try {
      const document = JSON.parse(readFileSync(file, "utf8")) as { mcpServers?: Record<string, Record<string, unknown>> };
      for (const [name, config] of Object.entries(document.mcpServers ?? {})) servers.set(name, { ...servers.get(name), ...config });
    } catch {
      // pi reports its own configuration errors; a server stays undescribed.
    }
  }
  return servers;
}
