// OAuth state shared by every pi process of one user: grants, bindings, pending
// logins and registrations in one 0600 JSON file under pi's agent directory, and
// client secrets in another. pi runs a process per terminal, RPC client and print
// run, so a token refreshed in one must be the token the others read.
//
// Locks are directories (mkdir is atomic): one for each file's read-modify-write,
// and one per key for `coordinate`. A holder refreshes its lock while it works; a
// lock whose owner died, or that nobody refreshed for STALE_MS, is broken.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import type { SecretStore, StoredRecord, TokenStore } from "agenthooksprotocol/oauth";

const STALE_MS = 30_000;
const HEARTBEAT_MS = 5_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Whether the lock at `path` was left by a process that will never release it. */
async function stale(path: string): Promise<boolean> {
  try {
    const owner = JSON.parse(await readFile(join(path, "owner"), "utf8")) as { pid?: number; host?: string };
    if (owner.host === hostname() && typeof owner.pid === "number" && !alive(owner.pid)) return true;
  } catch {
    // Not written yet, or already gone: only its age can tell.
  }
  try {
    return Date.now() - (await stat(path)).mtimeMs > STALE_MS;
  } catch {
    return false;
  }
}

/** Run `work` holding the lock directory `path`, across processes. Never starts
 * work after `signal` aborts; holds the lock until work settles. */
export async function withLock<T>(path: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let wait = 5; ; wait = Math.min(wait * 2, 100)) {
    signal.throwIfAborted();
    try {
      await mkdir(path, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (await stale(path)) {
      // Moved aside first: two breakers cannot both remove a fresh lock.
      const aside = `${path}.stale-${randomUUID()}`;
      await rename(path, aside).then(() => rm(aside, { recursive: true, force: true }), () => {});
      continue;
    }
    await sleep(wait, signal);
  }
  try {
    signal.throwIfAborted();
    await writeFile(join(path, "owner"), JSON.stringify({ pid: process.pid, host: hostname() }), { mode: 0o600 });
  } catch (error) {
    await rm(path, { recursive: true, force: true });
    throw error;
  }
  const heartbeat = setInterval(() => {
    const now = new Date();
    utimes(path, now, now).catch(() => {});
  }, HEARTBEAT_MS);
  heartbeat.unref();
  try {
    return await work();
  } finally {
    clearInterval(heartbeat);
    await rm(path, { recursive: true, force: true });
  }
}

/** A JSON object in a 0600 file, replaced atomically by rename. */
class JsonFile<T extends object> {
  #cache: { key: string; value: T } | undefined;

  constructor(readonly path: string, readonly empty: () => T) {}

  /** `fresh` skips the cache: a read-modify-write must see the file itself. */
  async read(fresh = false): Promise<T> {
    let info;
    try {
      info = await stat(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.empty();
      throw error;
    }
    // A rename gives a new inode: unchanged identity means unchanged content.
    const key = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    if (!fresh && this.#cache?.key === key) return structuredClone(this.#cache.value);
    const value = JSON.parse(await readFile(this.path, "utf8")) as T;
    this.#cache = { key, value };
    return structuredClone(value);
  }

  async write(value: T): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  /** Read, change and write under the file's lock. */
  update<R>(signal: AbortSignal, change: (value: T) => R | Promise<R>): Promise<R> {
    return withLock(`${this.path}.lock`, signal, async () => {
      const value = await this.read(true);
      const result = await change(value);
      signal.throwIfAborted();
      await this.write(value);
      return result;
    });
  }
}

type TokenFile = { version: 1; records: Record<string, StoredRecord> };

/** The managed OAuth store: `ahp-auth.json`, with locks under `ahp-auth.locks/`. */
export class FileTokenStore implements TokenStore {
  readonly #file: JsonFile<TokenFile>;
  readonly #locks: string;

  constructor(readonly path: string) {
    this.#file = new JsonFile(path, () => ({ version: 1, records: {} }));
    this.#locks = `${path.replace(/\.json$/, "")}.locks`;
  }

  async load(key: string, signal: AbortSignal): Promise<StoredRecord | undefined> {
    signal.throwIfAborted();
    return (await this.#file.read()).records[key];
  }

  async compareAndSet(key: string, expected: string | undefined, value: StoredRecord | undefined, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    let changed = false;
    await withLock(`${this.path}.lock`, signal, async () => {
      const file = await this.#file.read(true);
      if (file.records[key]?.generation !== expected) return;
      signal.throwIfAborted();
      if (value === undefined) delete file.records[key];
      else file.records[key] = value;
      await this.#file.write(file);
      changed = true;
    });
    return changed;
  }

  coordinate<T>(key: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    return withLock(join(this.#locks, createHash("sha256").update(key).digest("hex")), signal, work);
  }
}

type SecretFile = { version: 1; secrets: Record<string, string> };

/** Client secrets, by reference: `ahp-secrets.json`, apart from tokens. A person
 * may add their own (`clientSecretRef`, `tokenRef`); the SDK adds those it
 * registers under opaque references. */
export class FileSecrets implements SecretStore {
  readonly #file: JsonFile<SecretFile>;

  constructor(readonly path: string) {
    this.#file = new JsonFile(path, () => ({ version: 1, secrets: {} }));
  }

  async get(reference: string, signal: AbortSignal): Promise<string | undefined> {
    signal.throwIfAborted();
    const secrets = (await this.#file.read()).secrets ?? {};
    return Object.hasOwn(secrets, reference) ? secrets[reference] : undefined;
  }

  put(reference: string, secret: string, signal: AbortSignal): Promise<void> {
    return this.#file.update(signal, (file) => {
      file.secrets = { ...file.secrets, [reference]: secret };
    });
  }

  delete(reference: string, signal: AbortSignal): Promise<void> {
    return this.#file.update(signal, (file) => {
      if (file.secrets) delete file.secrets[reference];
    });
  }
}
