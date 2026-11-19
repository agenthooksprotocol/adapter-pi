// The loopback receiver for one login's redirect, as MCP clients do it: each
// sign-in binds its own ephemeral port on 127.0.0.1, and the pi process that
// prepared the login receives the callback and completes it. It never keeps pi
// alive, and closes when the login ends.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export const CALLBACK_PATH = "/callback";

/** Answers the login's callback with a page for the browser. */
export type CallbackHandler = (callback: string) => Promise<{ ok: boolean; message: string }>;

export interface Receiver {
  readonly redirectUri: string;
  /** The login's `state`, once known: other callbacks are refused. Cleared when
   * a callback for it is accepted, so only one is handled; the handler sets it
   * again if the login is still waiting. */
  state: string | undefined;
  close(): void;
}

function page(status: number, text: string): { status: number; body: string } {
  const escaped = text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return { status, body: `<!doctype html><meta charset="utf-8"><title>pi</title><p>${escaped}</p>` };
}

/** Listen on a fresh port for one login's redirect. */
export async function receive(handler: CallbackHandler): Promise<Receiver> {
  let receiver: Receiver;
  let answering = 0;
  let closed = false;
  /** States already handled here: a repeat gets a neutral page, not a failure. */
  const handled = new Set<string>();
  const server = createServer((request, response) => {
    answering++;
    void (async () => {
      const url = new URL(request.url ?? "/", receiver.redirectUri);
      let answer = page(404, "Not found.");
      if (request.method === "GET" && url.pathname === CALLBACK_PATH && url.searchParams.has("state")) {
        const state = url.searchParams.get("state")!;
        answer = page(400, "This sign-in is not one this pi is waiting for. Start it again with /ahp login.");
        if (receiver.state !== undefined && state === receiver.state) {
          // One callback per login: a browser's repeat (a reload, a double redirect)
          // must not report a failure beside the sign-in.
          receiver.state = undefined;
          handled.add(state);
          const result = await handler(url.href).catch(() => ({ ok: false, message: "Sign-in failed." }));
          answer = page(result.ok ? 200 : 400, result.message);
        } else if (handled.has(state)) {
          answer = page(200, "This sign-in was already received. You can close this tab.");
        }
      }
      response.writeHead(answer.status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      // A login completed by this callback closes its receiver: answer first.
      response.end(answer.body, () => {
        if (--answering === 0 && closed) server.closeAllConnections?.();
      });
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  server.on("error", () => {});
  server.unref();
  const { port } = server.address() as AddressInfo;
  receiver = {
    redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
    state: undefined,
    close() {
      closed = true;
      server.close();
      if (answering === 0) server.closeAllConnections?.();
      else server.closeIdleConnections?.();
    },
  };
  return receiver;
}
