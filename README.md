# Agent Hooks Protocol adapter for pi

A [pi](https://pi.dev) extension that delivers pi's events to
[Agent Hooks Protocol](https://github.com/agenthooksprotocol/agent-hooks-protocol)
backends and applies their effects natively. It is built on the
[AHP TypeScript SDK](https://github.com/agenthooksprotocol/typescript-sdk).

It needs pi 1.0 or later, and is tested against 1.0.0 and 1.5.0. Oh My Pi is a
separate distribution with its own extension API: this adapter does not target it.

## Install

```sh
pi install npm:@agenthooksprotocol/adapter-pi
```

While developing, load it from this checkout instead:

```sh
npm install && npm run build
pi -e .
```

## Register backends

The adapter reads AHP registrations (the spec's `hooks.json`) from four places and
merges them into one document:

| File | Scope |
| --- | --- |
| `~/.agents/hooks.json` | user |
| `~/.pi/agent/hooks.json` (`$PI_CODING_AGENT_DIR`) | user |
| `<cwd>/.agents/hooks.json` | project |
| `<cwd>/.pi/hooks.json` | project |

Later rows win: a backend in a later file replaces the backend with the same `id`
from an earlier one, so the project beats the user and `.pi` beats `.agents`. A file
or backend that is not valid is skipped with a warning, and the others still run.

```json
{
  "protocolVersion": "draft",
  "hooks": [
    {
      "id": "com.example.policy",
      "transport": { "type": "http", "url": "https://hooks.example/ahp" },
      "subscriptions": [
        {
          "mode": "intercept",
          "events": ["tool.before", "turn.start"],
          "timeoutMs": 2000,
          "failurePolicy": "fail-closed",
          "content": { "default": "body" }
        }
      ]
    }
  ]
}
```

Omit `subscriptions` to let the backend choose them (server-driven configuration).

Set `AHP_HOOKS_FILE` to one registration's absolute path to use that file alone, with
no discovery (tests, CI, a pinned deployment). Set `AHP_DEBUG=1` to print what the
adapter loaded and each delivery diagnostic to stderr.

### A project's registrations need a trust decision

A registration names where session content goes, so a repository must not be able to
choose that by shipping one. pi reports a project with none of the resources it
protects as trusted, and it does not know about `hooks.json`, so the adapter asks for
more: a project's files count only with a saved `/trust` decision, `--approve`,
`defaultProjectTrust: "always"`, or a yes to the question pi asks about the project's
own `.pi` resources. Until then the adapter says what it ignored. User files always
count.

## Sign in to a backend

A backend may need credentials. A `bearer` binding (`"authentication": { "type":
"bearer", "tokenEnv": "NAME" }`, or `tokenRef` naming a key in `ahp-secrets.json`) and
an `Authorization` header in `transport.headers` work as before. A backend behind
OAuth gets a browser sign-in:

- **At the next turn.** A delivery that needs a sign-in fails (the backend's failure
  policy applies) and never opens a browser. When the next turn starts, the adapter
  prepares the sign-in in the background and shows `Sign in to <backend>: <link>` in a
  widget above the editor and a notification: pi's own UI, never the transcript the
  model reads. Every turn shows the same link until it expires (10 minutes at most);
  then the next turn shows a fresh one. Backends that are signed in are left alone.
  When another pi signs in to the backend first, this one drops its link at its next
  turn and uses that sign-in.
- **Commands.** `/ahp status` says, per backend, `authorized`, `needs-login` with the
  link, `client-credentials`, or `failing` with why. `/ahp login [backend]` opens the
  browser (`$BROWSER`, or the platform's opener; `BROWSER=none` for none) and asks for
  the address the browser ended on, for when it cannot reach pi; with no backend it
  signs in each one that needs it. `/ahp logout <backend>` cancels its pending sign-in
  and forgets its token.
- **Without a UI** (`-p`, `--mode json`), the adapter writes that a backend needs a
  sign-in to stderr and relies on client credentials; `pi -p "/ahp login <backend>"`
  prints the link and waits for it.

As in MCP clients, each sign-in belongs to the pi that showed its link: that pi
listens on `http://127.0.0.1:<port>/callback`, on a port picked for that sign-in, for
as long as it is pending, and completes it (a pasted address too). Several pi
processes may each show their own link; the newest completed sign-in is the one they
all use, since tokens are shared. One sign-in covers a backend's event and upload
endpoints, and no other backend's.

Settings go in an `oauth` object on the backend, beside its `authentication`
(receivers ignore fields they do not know). All are optional:

```json
{
  "id": "com.example.policy",
  "transport": { "type": "http", "url": "https://hooks.example/ahp" },
  "oauth": {
    "issuer": "https://auth.example",
    "registration": true
  }
}
```

| Setting | Meaning |
| --- | --- |
| `issuer` | The authorization server trusted for this backend (or the `authentication` preset's). A backend's advertisement never chooses one by itself. Client credentials and client secrets always need it. |
| `trustAdvertisedIssuer` | Without `issuer`, trust the one issuer the backend advertises, for a public browser sign-in only, where you see where you sign in. Default `false`. |
| `flow` | `authorization_code_pkce` (default) or `client_credentials`. |
| `scopes` | Scopes to request. |
| `clientId` | A client registered for pi in advance. It always wins. |
| `clientSecretRef` | For client credentials: a key in `ahp-secrets.json`. |
| `clientMetadataDocument` | `{ "url", "redirectUris" }`: a Client ID Metadata Document you publish, used where the issuer supports them. `redirectUris` must include `http://127.0.0.1/callback`: loopback redirects match without their port, so it covers every sign-in's. |
| `registration` | `true`, or `{ "clientName", "scopes", "initialAccessTokenRef" }`: permission to register a client (RFC 7591) at `issuer`, which it requires. |
| `loginLifetimeMinutes` | How long a sign-in link lasts, up to 10 (the default). |
| `allowPrivateNetwork` | Allow the authorization server on loopback or private addresses. Default `false`. |

The registration's own `oauth` preset (`issuer`, `resource`, `clientId`, `flow`,
`scopes`, `clientSecretRef`) works too; the `oauth` object's settings take precedence.

OAuth requests go only to HTTPS endpoints, follow no redirects, and connect only to
the public addresses they resolved (unless `allowPrivateNetwork`).

### Where credentials live

pi has no credential store, so the adapter keeps two files in pi's agent directory
(`~/.pi/agent`, or `$PI_CODING_AGENT_DIR`), each written atomically with mode `0600`:

- `ahp-auth.json`: tokens, refresh tokens, discovery results and registered client
  ids, shared by every pi process of the user, so a refresh in one is the token the
  others read. Locks are under `ahp-auth.locks/` and `ahp-auth.json.lock`. Pending
  sign-ins stay in the pi that started them.
- `ahp-secrets.json`: client secrets, apart from tokens. Add your own as
  `{ "version": 1, "secrets": { "<ref>": "<secret>" } }` for `clientSecretRef`,
  `tokenRef` or `initialAccessTokenRef`; secrets of registered clients go here too.

## What reaches a backend

| AHP event | pi source | Effects applied |
| --- | --- | --- |
| `session.start` | `session_start` | inject, message |
| `session.end` | `session_shutdown` | observe |
| `turn.start` | `input`; `before_agent_start` or `agent_start` for a run an extension's message starts | deny, modify(prompt), inject, message |
| `turn.progress` | `message_update` | observe |
| `turn.finish.before` | `agent_before_settle` | flow continue/stop, message |
| `turn.end` | `agent_settled` | observe |
| `user.message.inbound` | `input` during a turn (steering, follow-ups) | deny, modify(prompt), message |
| `model.request.before` | `context`, `context_with_system` | deny, modify(request, system prompt included), inject, message |
| `model.response.after` | `message_end` | modify(response, tool calls included), message |
| `model.error` | `message_end` with an error | observe |
| `model.switch.before`, `model.switch.after` | `model_select` | deny, message; observe |
| `tool.before` | `tool_call` | deny, allow, ask, modify(input), return, inject, message |
| `tool.after` | `tool_result`; `tool_execution_end` for calls that never ran | modify(output), inject, message |
| `tool.progress` | `tool_execution_update` | observe |
| `tool.batch.after` | `turn_end` | inject, flow stop, message |
| `tool.permission.request`, `tool.permission.resolved` | after `ask` at `tool.before` | allow, deny, modify(input), flow stop, message; observe |
| `context.compact.before` | `session_before_compact` | deny, modify(instructions), return, message |
| `context.compact.after` | `session_compact`, `session_compact_failed` | observe |
| `config.change.after` | `thinking_level_select` | observe |
| `file.changed` | the `write` and `edit` tools | observe |
| `user.attention` | `ui_prompt_start` | observe |
| `hook.failure` | the SDK | observe |

A turn here is everything one prompt sets off, up to `agent_settled`; what pi calls a
turn is one model request, an `attempt` in AHP.

Some of these work differently from what pi's API offers directly:

- **`ask`.** pi has no permission system. `ask` runs one: `tool.permission.request`
  goes to backends, and if none decides, a dialog asks. Where pi has no UI (print
  mode), `ask` is not advertised and the permission events are never raised, and the
  manifest's gaps say so; a backend that returns `ask` anyway meets its failure policy.
  Asking comes before a `return` in the same answer.
- **`return` at `tool.before`.** pi has no way to skip a tool and supply its result. The
  call is blocked, and its message is rewritten at `message_end`, so the model reads a
  success. Other extensions' `tool_execution_end` sees a blocked call.
- **`deny` at `model.request.before`.** A handler's throw does not stop a request: pi
  logs it and sends the request. An abort does, so the turn ends `failed`, with
  `Denied`.
- **`deny` at `model.switch.before`.** `model_select` fires after the selection: the
  previous model is set back before anything else runs.
- **`modify(instructions)`.** pi takes no changed instructions from a handler: the
  adapter runs pi's own `compact()` with them and hands in the result.
- **`!!` commands.** Their output is the person's and the model does not read it, so
  they are left out of `model.request.before`.

Calls a codemode script makes carry pi's `<parent>/<n>` ids and hang off the script's
call through `parentEventId`. MCP tools are described as `mcp` when they come from
pi's built-in MCP extension; connection details leave out environment, headers and
command lines.

Everything the adapter cannot enforce is left unadvertised and listed in the
manifest's `gaps` ([`src/capabilities.ts`](src/capabilities.ts)). The ones to know:

- pi has no subagents of its own. A child `pi` an extension starts, such as the
  `pi-subagents` package's, reports as a separate session with no link to its parent.
- `!command` lines a person runs raise no event of their own: they are not agent tool
  calls, and AHP has none for them. Their output does appear in the next request.
- MCP tools from third-party bridges such as `pi-mcp-adapter` report as `native`.
- `config.change.before`, `workspace.change`, `task.change`, `user.elicitation` and
  `user.message.outbound` have no pi source.

## Content uploads

Images leave as attachment parts, uploaded only for a subscription that selects the
body and configures `upload`; the bytes never travel in event text.

## How it runs

pi runs extensions in-process on Node with its whole runtime, so the SDK's own fetch,
stdio and environment access apply. pi makes one extension instance per session
runtime, replacing it on `/new`, `/resume`, `/fork` and `/reload`: the adapter holds one
session and one client per instance, and drains deliveries at `session_shutdown`. A
`/reload` keeps the session, so it raises neither `session.end` nor `session.start`.

## Develop

```sh
npm run typecheck
npm test            # unit tests
npm run test:e2e    # real pi 1.0.0 and 1.5.0, a fake model, a recording backend, a fake OAuth server
```

The end-to-end tests drive pi over its RPC mode with an isolated home, from a packed
copy of this package: nothing reaches a real backend or provider.
