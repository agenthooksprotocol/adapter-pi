import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StoredRecord } from "agenthooksprotocol/oauth";
import { FileSecrets, FileTokenStore, withLock } from "../../src/oauth/store.ts";

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

test("a lock its dead owner left behind is broken; a waiter honours its signal", async () => {
  const lock = join(root, "locks", "held");
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "owner"), JSON.stringify({ pid: 2 ** 22 + 12345, host: (await import("node:os")).hostname() }));
  expect(await withLock(lock, signal(), async () => "ran")).toBe("ran");

  let release!: () => void;
  const held = withLock(lock, signal(), () => new Promise<void>((resolve) => (release = resolve)));
  await Bun.sleep(20);
  const controller = new AbortController();
  const waiting = withLock(lock, controller.signal, async () => "never");
  controller.abort(new Error("gave up"));
  await expect(waiting).rejects.toThrow("gave up");
  release();
  await held;
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
