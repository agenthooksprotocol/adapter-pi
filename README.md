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
npm run test:e2e    # real pi 1.0.0 and 1.5.0, a fake model, a recording backend
```

The end-to-end tests drive pi over its RPC mode with an isolated home, from a packed
copy of this package: nothing reaches a real backend or provider.
