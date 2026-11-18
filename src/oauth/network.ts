// Where OAuth requests may go. Metadata, registration and token requests leave
// through `policyFetch`: HTTPS with Node's certificate validation, no redirects,
// and a DNS lookup that refuses private, loopback and link-local addresses and
// pins the connection to the addresses it checked, so a rebinding name cannot
// switch them after the check. A backend may allow its private network.
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { AuthError } from "agenthooksprotocol/client";
import type { NetworkPurpose, Operation, PolicyFetch } from "agenthooksprotocol/oauth";

/** A globally routable unicast address. */
export function publicAddress(address: string): boolean {
  const host = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (host.includes(":")) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
    if (mapped) return publicAddress(mapped[1]!);
    return /^[23][\da-f]{3}:/.test(host) && !/^(?:2001:(?:db8|0):|2002:)/.test(host);
  }
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a = 0, b = 0, c = 0] = octets;
  return !(
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function forbidden(): never {
  throw new AuthError("untrusted_destination");
}

function bare(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "");
}

/** Names that never resolve on the public internet. */
function localName(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".");
}

export interface NetworkPolicy {
  checkDestination(url: URL, purpose: NetworkPurpose, operation: Operation): Promise<void>;
  policyFetch: PolicyFetch;
}

export function networkPolicy(allowPrivateNetwork: boolean): NetworkPolicy {
  const permitted = (address: string) => allowPrivateNetwork || publicAddress(address);

  async function checkDestination(url: URL, _purpose: NetworkPurpose, operation: Operation): Promise<void> {
    operation.signal.throwIfAborted();
    if (url.protocol !== "https:" || url.username || url.password) forbidden();
    const host = bare(url.hostname.toLowerCase());
    if (isIP(host)) {
      if (!permitted(host)) forbidden();
      return;
    }
    if (allowPrivateNetwork) return;
    if (localName(host)) forbidden();
    const addresses = await lookup(host, { all: true }).catch(() => forbidden());
    if (!addresses.length || addresses.some((entry) => !permitted(entry.address))) forbidden();
  }

  /** Resolve once, check every address, connect only to those. */
  const pinned = (host: string, options: { all?: boolean; family?: number | string }, callback: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) => {
    dnsLookup(host, { all: true, family: options.family as 0 | 4 | 6 | undefined }, (error, addresses) => {
      if (error) return callback(error, []);
      if (!addresses.length || addresses.some((entry) => !permitted(entry.address))) {
        return callback(Object.assign(new Error("Forbidden OAuth destination"), { code: "EACCES" }), []);
      }
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  };

  const policyFetch: PolicyFetch = (target, init, { operation }) => new Promise<Response>((resolve, reject) => {
    const url = new URL(target);
    if (url.protocol !== "https:" || url.username || url.password) return reject(new AuthError("untrusted_destination"));
    const host = bare(url.hostname.toLowerCase());
    if (isIP(host) ? !permitted(host) : !allowPrivateNetwork && localName(host)) return reject(new AuthError("untrusted_destination"));
    const headers = new Headers(init.headers);
    let body = init.body;
    if (body instanceof URLSearchParams) {
      if (!headers.has("content-type")) headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
      body = body.toString();
    }
    if (body !== undefined && body !== null && typeof body !== "string" && !(body instanceof Uint8Array)) {
      return reject(new TypeError("Unsupported OAuth request body"));
    }
    const signal = init.signal ? AbortSignal.any([init.signal, operation.signal]) : operation.signal;
    const outgoing = request(url, {
      method: init.method ?? "GET",
      headers: Object.fromEntries((headers as unknown as Iterable<[string, string]>)),
      lookup: pinned as never,
      signal,
    }, (incoming) => {
      const status = incoming.statusCode ?? 0;
      // Never followed: a redirect is a failure, as fetch's redirect: "error".
      if (status >= 300 && status < 400) {
        incoming.destroy();
        return reject(new TypeError("OAuth request redirected"));
      }
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value === undefined) continue;
        for (const item of Array.isArray(value) ? value : [value]) responseHeaders.append(name, item);
      }
      const empty = status === 204 || status === 304 || init.method === "HEAD";
      if (empty) incoming.resume();
      resolve(new Response(empty ? null : (Readable.toWeb(incoming) as unknown as ReadableStream), { status, headers: responseHeaders }));
    });
    outgoing.on("error", reject);
    outgoing.end(body ?? undefined);
  });

  return { checkDestination, policyFetch };
}
