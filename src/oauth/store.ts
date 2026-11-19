// OAuth state shared by every pi process of one user: grants, bindings and
// registrations in one 0600 JSON file under pi's agent directory, and client
// secrets in another. pi runs a process per terminal, RPC client and print run, so
// a token refreshed in one must be the token the others read: refreshes are
// serialised across processes by `coordinate`. Pending logins stay in the process
// that started them.
//
// Locks are directories: one for each file's read-modify-write, and one per key
// for `coordinate`. A lock is taken by renaming a prepared directory, its owner
// (host, pid and a random token) already inside, into place, so no lock exists
// without its token; one that does is taken. A holder refreshes its lock while it
// works. A lock whose owner on this host has died is broken; one from another host
// once nobody refreshed it for STALE_MS; any once nobody refreshed it for
// BACKSTOP_MS (a reused pid). A break or release removes a lock only while it
// holds the token it was judged by.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import type { SecretStore, StoredRecord, TokenStore } from "agenthooksprotocol/oauth";

const STALE_MS = 30_000;
/** Well above the SDK's 30s commit budget: no holder legitimately goes this long. */
const BACKSTOP_MS = 10 * 60_000;
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

type Owner = { pid?: number; host?: string; token?: string };

async function owner(path: string): Promise<Owner | undefined> {
  try {
    return JSON.parse(await readFile(join(path, "owner"), "utf8")) as Owner;
  } catch {
    return undefined;
  }
}

/** Milliseconds since the lock was taken or last refreshed. */
async function age(path: string): Promise<number | undefined> {
  try {
    return Date.now() - (await stat(path)).mtimeMs;
  } catch {
    return undefined;
  }
}

/** The owner token of a lock whose holder will never release it, else undefined.
 * On this host a live pid keeps its lock (stopped, sleeping, or its clock
 * stepped) up to BACKSTOP_MS without a heartbeat, past which the pid is taken to
 * be another process's. Another host's lock lasts STALE_MS without one. */
export async function abandoned(path: string): Promise<string | undefined> {
  const found = await owner(path);
  const since = await age(path);
  if (typeof found?.token !== "string" || since === undefined) return undefined;
  const local = found.host === hostname() && typeof found.pid === "number";
  const held = local ? alive(found.pid!) && since <= BACKSTOP_MS : since <= STALE_MS;
  return held ? undefined : found.token;
}

/** Move the lock aside, if it still holds `token`. */
async function remove(path: string, token: string): Promise<boolean> {
  if ((await owner(path))?.token !== token) return false;
  const aside = `${path}.removed-${randomUUID()}`;
  try {
    await rename(path, aside);
  } catch {
    return false;
  }
  await rm(aside, { recursive: true, force: true });
  return true;
}

/** Break the lock only while it holds the token judged abandoned. Breakers take
 * turns under `<path>.break`. True when the lock is gone. */
export async function breakLock(path: string, judged: string): Promise<boolean> {
  const breaker = `${path}.break`;
  try {
    await mkdir(breaker, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Held for moments; one left by a crash is cleared once old.
    if (((await age(breaker)) ?? 0) > STALE_MS) await rm(breaker, { recursive: true, force: true });
    return false;
  }
  try {
    return await remove(path, judged);
  } finally {
    await rm(breaker, { recursive: true, force: true });
  }
}

/** Run `work` holding the lock directory `path`, across processes. Never starts
 * work after `signal` aborts; holds the lock until work settles. */
export async function withLock<T>(path: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const prepared = `${path}.${token}.acquire`;
  await mkdir(prepared, { mode: 0o700 });
  try {
    await writeFile(join(prepared, "owner"), JSON.stringify({ pid: process.pid, host: hostname(), token }), { mode: 0o600 });
    for (let wait = 5; ; wait = Math.min(wait * 2, 100)) {
      signal.throwIfAborted();
      try {
        await rename(prepared, path);
        break;
      } catch (error) {
        // A held lock is a directory with its owner inside: rename cannot replace it
        // (EEXIST or ENOTEMPTY; EPERM on Windows). Released since: try again.
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "ENOTEMPTY" && (await age(path)) === undefined) throw error;
      }
      const judged = await abandoned(path);
      if (judged && (await breakLock(path, judged))) continue;
      await sleep(wait, signal);
    }
  } catch (error) {
    await rm(prepared, { recursive: true, force: true });
    throw error;
  }
  const heartbeat = setInterval(() => {
    const now = new Date();
    utimes(path, now, now).catch(() => {});
  }, HEARTBEAT_MS);
  heartbeat.unref();
  try {
    signal.throwIfAborted();
    return await work();
  } finally {
    clearInterval(heartbeat);
    // Only our own: a lock judged abandoned and replaced is someone else's now.
    await remove(path, token);
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
