// Where OAuth requests may go. Metadata, registration and token requests leave
// through `policyFetch`: HTTPS with Node's certificate validation, no redirects,
// and a DNS lookup that refuses every address that is not globally reachable and
// pins the connection to the addresses it checked, so a rebinding name cannot
// switch them after the check. A backend may allow its private network.
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";
import { AuthError } from "agenthooksprotocol/client";
import type { NetworkPurpose, Operation, PolicyFetch } from "agenthooksprotocol/oauth";

/** Special-purpose IPv4 ranges that are not globally reachable (IANA registry). */
const privateV4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) privateV4.addSubnet(network, prefix, "ipv4");

/** IPv6 is global only inside 2000::/3, and not in these parts of it: IETF
 * protocol assignments (Teredo, benchmarking, ORCHID), documentation, 6to4. */
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const privateV6 = new BlockList();
for (const [network, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) privateV6.addSubnet(network, prefix, "ipv6");

/** An IPv4-mapped address (::ffff:a.b.c.d, in any spelling) as its IPv4 form. */
function unmapped(address: string): string | undefined {
  let canonical: string;
  try {
    canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  } catch {
    return undefined;
  }
  const mapped = /^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/.exec(canonical);
  if (!mapped) return undefined;
  const high = Number.parseInt(mapped[1]!, 16), low = Number.parseInt(mapped[2]!, 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

/** A globally routable unicast address. Anything that is not an IP is not. */
export function publicAddress(address: string): boolean {
  const host = address.toLowerCase().replace(/^\[|\]$/g, "");
  const family = isIP(host);
  if (family === 4) return !privateV4.check(host, "ipv4");
  if (family !== 6) return false;
  const v4 = unmapped(host);
  if (v4 !== undefined) return publicAddress(v4);
  return globalV6.check(host, "ipv6") && !privateV6.check(host, "ipv6");
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
