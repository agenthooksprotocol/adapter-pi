// A backend's OAuth settings: its registration `authentication` preset, and the
// adapter's own `oauth` object beside it in hooks.json. AHP receivers ignore
// unknown registration fields, so the SDK passes `oauth` by; this reads it.
//
//   "oauth": {
//     "issuer": "https://auth.example.com",   // the one issuer trusted for this backend
//     "trustAdvertisedIssuer": false,         // or, for a browser sign-in only, the one it advertises
//     "flow": "authorization_code_pkce",      // or "client_credentials"
//     "scopes": ["hooks"],
//     "clientId": "pi",                       // a pre-registered client, or:
//     "clientSecretRef": "example-secret",    // client credentials: a key in ahp-secrets.json
//     "clientMetadataDocument": { "url": "https://…/client.json", "redirectUris": ["http://127.0.0.1:33418/callback"] },
//     "registration": true,                   // or { "clientName", "scopes", "initialAccessTokenRef" }: DCR at `issuer`
//     "redirectPort": 33418,
//     "loginLifetimeMinutes": 10,
//     "allowPrivateNetwork": false
//   }
import { redirectUri } from "./callback.js";

export type Flow = "authorization_code_pkce" | "client_credentials";

export interface Endpoint {
  purpose: "event" | "upload";
  url: string;
  /** The endpoint's registration binding, as the SDK hands it to a provider. */
  authentication?: Record<string, unknown>;
}

export interface OAuthSettings {
  issuer?: string;
  /** Without `issuer`, trust the one issuer the backend advertises, for a public
   * browser sign-in only: the person sees where they sign in. */
  trustAdvertisedIssuer: boolean;
  flow?: Flow;
  scopes?: string[];
  clientId?: string;
  clientSecretRef?: string;
  clientMetadataDocument?: { url: string; redirectUris: string[] };
  registration?: { clientName?: string; scopes?: string[]; initialAccessTokenRef?: string };
  redirectPort: number;
  loginLifetimeMs: number;
  allowPrivateNetwork: boolean;
}

export interface BackendAuth {
  id: string;
  /** HTTP endpoints, event first. Empty for stdio. */
  endpoints: Endpoint[];
  /** The registration's `authentication`, if any. */
  preset?: Record<string, unknown>;
  /** `transport.headers` sets Authorization: the SDK sends that and nothing else. */
  headerAuthorization: boolean;
  /** An `oauth` object was given: the person expects OAuth here. */
  configured: boolean;
  settings: OAuthSettings;
  redirectUri: string;
}

const MAX_LIFETIME_MS = 600_000;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

/** A stable port per backend: every pi process derives the same redirect. */
export function defaultPort(id: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(id)) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return 20000 + (hash % 10000);
}

/** Read one backend; problems name settings that were ignored. */
export function backendAuth(backend: Record<string, unknown>): { auth: BackendAuth; problems: string[] } {
  const id = String(backend.id);
  const problems: string[] = [];
  const transport = object(backend.transport) ? backend.transport : {};
  const endpoints: Endpoint[] = [];
  const preset = object(backend.authentication) ? backend.authentication : undefined;
  if (transport.type === "http" && typeof transport.url === "string") {
    endpoints.push({ purpose: "event", url: transport.url, ...(preset ? { authentication: preset } : {}) });
    const uploads = new Set<string>();
    for (const subscription of Array.isArray(backend.subscriptions) ? backend.subscriptions : []) {
      const upload = object(subscription) && object(subscription.upload) ? subscription.upload : undefined;
      if (!upload || typeof upload.endpoint !== "string" || uploads.has(upload.endpoint)) continue;
      uploads.add(upload.endpoint);
      endpoints.push({ purpose: "upload", url: upload.endpoint, ...(object(upload.auth) ? { authentication: upload.auth } : {}) });
    }
  }
  const headers = object(transport.headers) ? transport.headers : {};
  const headerAuthorization = Object.keys(headers).some((name) => name.toLowerCase() === "authorization");

  const raw = backend.oauth;
  const settings: OAuthSettings = { trustAdvertisedIssuer: false, redirectPort: defaultPort(id), loginLifetimeMs: MAX_LIFETIME_MS, allowPrivateNetwork: false };
  const ignore = (name: string, why: string) => problems.push(`${id}: oauth.${name} ${why}; ignored`);
  if (raw !== undefined && !object(raw)) problems.push(`${id}: oauth is not an object; ignored`);
  const given = object(raw) ? raw : {};
  if (given.issuer !== undefined) {
    if (typeof given.issuer === "string" && given.issuer.startsWith("https://")) settings.issuer = given.issuer;
    else ignore("issuer", "is not an https URL");
  }
  if (given.flow !== undefined) {
    if (given.flow === "authorization_code_pkce" || given.flow === "client_credentials") settings.flow = given.flow;
    else ignore("flow", 'is not "authorization_code_pkce" or "client_credentials"');
  }
  for (const name of ["clientId", "clientSecretRef"] as const) {
    if (given[name] === undefined) continue;
    if (typeof given[name] === "string" && given[name]) settings[name] = given[name] as string;
    else ignore(name, "is not a string");
  }
  if (given.scopes !== undefined) {
    if (strings(given.scopes)) settings.scopes = given.scopes;
    else ignore("scopes", "is not a list of strings");
  }
  const document = given.clientMetadataDocument;
  if (document !== undefined) {
    if (object(document) && typeof document.url === "string" && strings(document.redirectUris)) settings.clientMetadataDocument = { url: document.url, redirectUris: document.redirectUris };
    else ignore("clientMetadataDocument", "needs url and redirectUris");
  }
  const registration = given.registration;
  if (registration !== undefined && registration !== false) {
    if (registration === true) settings.registration = {};
    else if (object(registration)) {
      settings.registration = {
        ...(typeof registration.clientName === "string" ? { clientName: registration.clientName } : {}),
        ...(strings(registration.scopes) ? { scopes: registration.scopes } : {}),
        ...(typeof registration.initialAccessTokenRef === "string" ? { initialAccessTokenRef: registration.initialAccessTokenRef } : {}),
      };
    } else ignore("registration", "is not true or an object");
    // Permission to register is for one issuer, named here.
    if (settings.registration && !settings.issuer) {
      delete settings.registration;
      ignore("registration", "needs oauth.issuer");
    }
  }
  if (given.redirectPort !== undefined) {
    const port = given.redirectPort;
    if (typeof port === "number" && Number.isInteger(port) && port >= 1024 && port <= 65535) settings.redirectPort = port;
    else ignore("redirectPort", "is not a port from 1024 to 65535");
  }
  if (given.loginLifetimeMinutes !== undefined) {
    const minutes = given.loginLifetimeMinutes;
    if (typeof minutes === "number" && minutes > 0 && minutes <= 10) settings.loginLifetimeMs = Math.round(minutes * 60_000);
    else ignore("loginLifetimeMinutes", "is not more than 0 and at most 10");
  }
  if (given.trustAdvertisedIssuer !== undefined) {
    if (typeof given.trustAdvertisedIssuer === "boolean") settings.trustAdvertisedIssuer = given.trustAdvertisedIssuer;
    else ignore("trustAdvertisedIssuer", "is not a boolean");
  }
  if (given.allowPrivateNetwork !== undefined) {
    if (typeof given.allowPrivateNetwork === "boolean") settings.allowPrivateNetwork = given.allowPrivateNetwork;
    else ignore("allowPrivateNetwork", "is not a boolean");
  }
  return {
    auth: {
      id,
      endpoints,
      ...(preset ? { preset } : {}),
      headerAuthorization,
      configured: object(raw),
      settings,
      redirectUri: redirectUri(settings.redirectPort),
    },
    problems,
  };
}

/** The issuer a backend may use among those advertised, or undefined. A server's
 * advertisement never selects a trusted issuer by itself: it needs `issuer` (or a
 * preset's), or the explicit `trustAdvertisedIssuer` for a public browser sign-in.
 * A client secret or client credentials always need a configured issuer. */
export function trustedIssuer(options: { configured: string | undefined; trustAdvertised: boolean; flow: Flow; confidential: boolean; advertised: readonly string[] }): string | undefined {
  const { configured, trustAdvertised, flow, confidential, advertised } = options;
  if (configured !== undefined) return advertised.includes(configured) ? configured : undefined;
  if (!trustAdvertised || flow !== "authorization_code_pkce" || confidential || advertised.length !== 1) return undefined;
  return advertised[0];
}
