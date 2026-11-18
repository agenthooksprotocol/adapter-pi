import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StoredRecord } from "agenthooksprotocol/oauth";
import { abandoned, breakLock, FileSecrets, FileTokenStore, withLock } from "../../src/oauth/store.ts";

const root = mkdtempSync(join(tmpdir(), "ahp-pi-store-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const signal = () => AbortSignal.timeout(20_000);
const grant = (generation: string, token = "t"): StoredRecord => ({ kind: "grant", generation, token, scopes: [] });

test("compare-and-set writes only over the generation it expects", async () => {
  const path = join(root, "cas", "ahp-auth.json");
  const store = new FileTokenStore(path);
  expect(await store.load("k", signal())).toBeUndefined();
  expect(await store.compareAndSet("k", "nope", grant("1"), signal())).toBe(false);
  expect(await store.compareAndSet("k", undefined, grant("1"), signal())).toBe(true);
  expect(await store.compareAndSet("k", undefined, grant("2"), signal())).toBe(false);
  expect(await store.compareAndSet("k", "1", grant("2", "u"), signal())).toBe(true);
  expect(await store.load("k", signal())).toEqual(grant("2", "u"));
  // Another instance over the same file sees it, and a stale one cannot win.
  const other = new FileTokenStore(path);
  expect(await other.compareAndSet("k", "1", grant("3"), signal())).toBe(false);
  expect(await other.compareAndSet("k", "2", undefined, signal())).toBe(true);
  expect(await store.load("k", signal())).toBeUndefined();
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("an aborted write commits nothing", async () => {
  const store = new FileTokenStore(join(root, "abort", "ahp-auth.json"));
  const controller = new AbortController();
  controller.abort();
  await expect(store.compareAndSet("k", undefined, grant("1"), controller.signal)).rejects.toBeDefined();
  expect(await store.load("k", signal())).toBeUndefined();
});

test("coordinate serializes work across processes, and every increment lands", async () => {
  const path = join(root, "procs", "ahp-auth.json");
  const script = join(root, "worker.ts");
  writeFileSync(script, `
    import { FileTokenStore } from ${JSON.stringify(join(import.meta.dir, "../../src/oauth/store.ts"))};
    import { appendFileSync } from "node:fs";
    const store = new FileTokenStore(process.argv[2]);
    for (let i = 0; i < 5; i++) {
      await store.coordinate("counter", AbortSignal.timeout(20000), async () => {
        appendFileSync(process.argv[3], "enter\\n");
        const current = await store.load("counter", AbortSignal.timeout(20000));
        const n = current ? Number(current.generation) : 0;
        await Bun.sleep(5);
        if (!(await store.compareAndSet("counter", current?.generation, { kind: "grant", generation: String(n + 1), scopes: [] }, AbortSignal.timeout(20000)))) throw new Error("lost a race inside coordinate");
        appendFileSync(process.argv[3], "leave\\n");
      });
    }
  `);
  const trace = join(root, "trace");
  writeFileSync(trace, "");
  const workers = Array.from({ length: 4 }, () => Bun.spawn(["bun", script, path, trace], { stderr: "pipe" }));
  for (const worker of workers) expect(await worker.exited).toBe(0);
  expect((await new FileTokenStore(path).load("counter", signal()))?.generation).toBe("20");
  // Never two inside at once.
  const lines = readFileSync(trace, "utf8").trim().split("\n");
  expect(lines.length).toBe(40);
  lines.forEach((line, index) => expect(line).toBe(index % 2 === 0 ? "enter" : "leave"));
}, 30_000);

const DEAD_PID = 2 ** 22 + 12345;

function deadLock(lock: string, host = hostname()) {
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "owner"), JSON.stringify({ pid: DEAD_PID, host, token: "dead" }));
}

test("a dead owner's lock is broken by exactly one of many waiters at a time", async () => {
  for (let round = 0; round < 20; round++) {
    const lock = join(root, "contended", String(round));
    deadLock(lock);
    let holders = 0;
    let most = 0;
    await Promise.all(Array.from({ length: 12 }, () => withLock(lock, signal(), async () => {
      most = Math.max(most, ++holders);
      await Bun.sleep(1);
      holders--;
    })));
    expect(most).toBe(1);
    expect(existsSync(lock)).toBe(false);
  }
}, 30_000);

test("a live owner on this host keeps its lock past the heartbeat timeout; a waiter honours its signal", async () => {
  const sleeper = Bun.spawn(["sleep", "30"]);
  try {
    const lock = join(root, "locks", "live");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner"), JSON.stringify({ pid: sleeper.pid, host: hostname(), token: "live" }));
    const stopped = new Date(Date.now() - 5 * 60_000);
    utimesSync(lock, stopped, stopped);
    await expect(withLock(lock, AbortSignal.timeout(300), async () => "stolen")).rejects.toBeDefined();
    expect(JSON.parse(readFileSync(join(lock, "owner"), "utf8")).token).toBe("live");
  } finally {
    sleeper.kill();
  }
});

test("a live pid with no heartbeat past the backstop is someone else's: the lock is broken", async () => {
  const lock = join(root, "locks", "reused");
  mkdirSync(lock, { recursive: true });
  // pid 1 always runs: the pid of a holder that died and was reused.
  writeFileSync(join(lock, "owner"), JSON.stringify({ pid: 1, host: hostname(), token: "gone" }));
  const long = new Date(Date.now() - 11 * 60_000);
  utimesSync(lock, long, long);
  expect(await withLock(lock, AbortSignal.timeout(2_000), async () => "ran")).toBe("ran");
});

test("a waiter backs off while another breaks the lock, and does not spin", async () => {
  const lock = join(root, "locks", "breaking");
  deadLock(lock);
  mkdirSync(`${lock}.break`);
  const cpu = process.cpuUsage();
  const started = Date.now();
  await expect(withLock(lock, AbortSignal.timeout(1_000), async () => "early")).rejects.toBeDefined();
  const used = process.cpuUsage(cpu);
  expect((used.user + used.system) / 1000).toBeLessThan((Date.now() - started) * 0.3);
  rmSync(`${lock}.break`, { recursive: true });
  expect(await withLock(lock, signal(), async () => "ran")).toBe("ran");
});

test("a break removes only the lock holding the token it judged", async () => {
  const lock = join(root, "locks", "judged");
  deadLock(lock);
  const judged = await abandoned(lock);
  expect(judged).toBe("dead");
  // Replaced by another holder, as abandoned as the first, before the break.
  rmSync(lock, { recursive: true });
  mkdirSync(lock);
  writeFileSync(join(lock, "owner"), JSON.stringify({ pid: DEAD_PID, host: hostname(), token: "next" }));
  expect(await breakLock(lock, judged!)).toBe(false);
  expect(JSON.parse(readFileSync(join(lock, "owner"), "utf8")).token).toBe("next");
  expect(await breakLock(lock, (await abandoned(lock))!)).toBe(true);
  expect(existsSync(lock)).toBe(false);
});

test("a lock is never seen without its owner: every holder's token is in place before its work", async () => {
  const lock = join(root, "locks", "whole");
  let ownerless = 0;
  let watching = true;
  const watch = (async () => {
    while (watching) {
      // One listing of whatever directory is the lock at that moment.
      let names: string[] | undefined;
      try {
        names = readdirSync(lock);
      } catch {}
      if (names && !names.includes("owner")) ownerless++;
      await Bun.sleep(0);
    }
  })();
  await Promise.all(Array.from({ length: 10 }, (_, index) => withLock(lock, signal(), async () => {
    expect(JSON.parse(readFileSync(join(lock, "owner"), "utf8")).pid).toBe(process.pid);
    await Bun.sleep(index % 3);
  })));
  watching = false;
  await watch;
  expect(ownerless).toBe(0);
  // No prepared directory is left behind.
  expect(readdirSync(join(root, "locks")).filter((name) => name.startsWith("whole."))).toEqual([]);
});

test("another host's lock is broken only once nobody refreshes it", async () => {
  const lock = join(root, "locks", "remote");
  deadLock(lock, "elsewhere");
  await expect(withLock(lock, AbortSignal.timeout(200), async () => "early")).rejects.toBeDefined();
  const long = new Date(Date.now() - 60_000);
  utimesSync(lock, long, long);
  expect(await withLock(lock, signal(), async () => "ran")).toBe("ran");
});

test("release removes only the holder's own lock", async () => {
  const lock = join(root, "locks", "replaced");
  await withLock(lock, signal(), async () => {
    // Someone judged it abandoned and took it over.
    writeFileSync(join(lock, "owner"), JSON.stringify({ pid: process.pid, host: hostname(), token: "theirs" }));
  });
  expect(JSON.parse(readFileSync(join(lock, "owner"), "utf8")).token).toBe("theirs");
});

test("secrets live in their own 0600 file, by reference", async () => {
  const path = join(root, "secrets", "ahp-secrets.json");
  const secrets = new FileSecrets(path);
  expect(await secrets.get("a", signal())).toBeUndefined();
  await secrets.put("a", "s3cret", signal());
  await new FileSecrets(path).put("b", "other", signal());
  expect(await secrets.get("a", signal())).toBe("s3cret");
  await secrets.delete("a", signal());
  expect(await secrets.get("a", signal())).toBeUndefined();
  expect(await secrets.get("b", signal())).toBe("other");
  expect(await secrets.get("toString", signal())).toBeUndefined();
  expect(statSync(path).mode & 0o777).toBe(0o600);
});
