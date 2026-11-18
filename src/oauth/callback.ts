// The loopback receiver for OAuth redirects. One per port per process, held in a
// process-wide registry: pi replaces the extension instance on /new, /resume,
// /fork and /reload, and a sign-in started before that must still complete. It
// listens until the last login it serves expires, and never keeps pi alive.
//
// Every pi process of a user shares one fixed port per backend, so only one of
// them listens; the rest find the port taken and leave the callback to it. Any of
// them can complete the login, because the login lives in the shared store.
import { createServer, type Server } from "node:http";

/** Answers a callback when it belongs to one of its logins, else undefined. */
export type CallbackHandler = (callback: string) => Promise<{ ok: boolean; message: string } | undefined>;

interface Receiver {
  server: Server;
  until: number;
  timer?: ReturnType<typeof setTimeout>;
  handlers: Map<string, CallbackHandler>;
}

/** Logins whose port another process held: retried until they expire, so the
 * link still works when that process exits. */
interface Waiting {
  until: number;
  handlers: Map<string, CallbackHandler>;
  timer?: ReturnType<typeof setTimeout>;
  binding?: Promise<boolean>;
}

const registry = globalThis as Record<symbol, unknown>;
const receivers = (registry[Symbol.for("agenthooksprotocol.adapter-pi.callbacks")] ??= new Map()) as Map<number, Receiver>;
const waiting = (registry[Symbol.for("agenthooksprotocol.adapter-pi.waiting")] ??= new Map()) as Map<number, Waiting>;

/** How often a taken port is tried again. */
export const RETRY_MS = 2_000;

export const CALLBACK_PATH = "/callback";

export function redirectUri(port: number): string {
  return `http://127.0.0.1:${port}${CALLBACK_PATH}`;
}

function page(status: number, text: string): { status: number; body: string } {
  const escaped = text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return { status, body: `<!doctype html><meta charset="utf-8"><title>pi</title><p>${escaped}</p>` };
}

function schedule(port: number, receiver: Receiver): void {
  clearTimeout(receiver.timer);
  receiver.timer = setTimeout(() => close(port), Math.max(0, receiver.until - Date.now()));
  receiver.timer.unref();
}

/** Listen on `port` until `until` (Unix ms) for `key`'s logins. False while
 * another process holds the port: it receives the callback, and this one keeps
 * trying to take the port over until the login expires. */
export async function receive(port: number, until: number, key: string, handler: CallbackHandler): Promise<boolean> {
  const existing = receivers.get(port);
  if (existing) {
    existing.handlers.set(key, handler);
    if (until > existing.until) {
      existing.until = until;
      schedule(port, existing);
    }
    return true;
  }
  const wait = waiting.get(port) ?? { until, handlers: new Map<string, CallbackHandler>() };
  wait.handlers.set(key, handler);
  wait.until = Math.max(wait.until, until);
  waiting.set(port, wait);
  return attempt(port);
}

async function attempt(port: number): Promise<boolean> {
  const wait = waiting.get(port);
  if (!wait) return receivers.has(port);
  wait.binding ??= (async () => {
    clearTimeout(wait.timer);
    const server = await bind(port, wait.handlers);
    if (server) {
      waiting.delete(port);
      const receiver: Receiver = { server, until: wait.until, handlers: wait.handlers };
      receivers.set(port, receiver);
      schedule(port, receiver);
      return true;
    }
    if (Date.now() + RETRY_MS < wait.until) {
      wait.timer = setTimeout(() => void attempt(port).catch(() => {}), RETRY_MS);
      wait.timer.unref();
    } else waiting.delete(port);
    return false;
  })().finally(() => {
    wait.binding = undefined;
  });
  return wait.binding;
}

/** A listening server, or undefined when the port is taken. */
async function bind(port: number, handlers: Map<string, CallbackHandler>): Promise<Server | undefined> {
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", redirectUri(port));
      let answer = page(404, "Not found.");
      if (request.method === "GET" && url.pathname === CALLBACK_PATH && url.searchParams.has("state")) {
        answer = page(400, "This sign-in is not one pi is waiting for. Start it again with /ahp login.");
        for (const handle of [...handlers.values()]) {
          const result = await handle(url.href).catch(() => ({ ok: false, message: "Sign-in failed." }));
          if (!result) continue;
          answer = page(result.ok ? 200 : 400, result.message);
          break;
        }
      }
      response.writeHead(answer.status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(answer.body);
    })();
  });
  const listening = await new Promise<boolean>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => (error.code === "EADDRINUSE" ? resolve(false) : reject(error)));
    server.listen(port, "127.0.0.1", () => resolve(true));
  });
  if (!listening) return undefined;
  server.on("error", () => {});
  server.unref();
  return server;
}

export function listening(port: number): boolean {
  return receivers.has(port);
}

export function close(port: number): void {
  const wait = waiting.get(port);
  if (wait) {
    clearTimeout(wait.timer);
    waiting.delete(port);
  }
  const receiver = receivers.get(port);
  if (!receiver) return;
  receivers.delete(port);
  clearTimeout(receiver.timer);
  receiver.server.close();
  receiver.server.closeAllConnections?.();
}
