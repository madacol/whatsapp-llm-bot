# ACP Migration

Madabot uses ACP as the harness layer for Codex, Claude, Pi, and any additional
ACP-compatible agents registered through `MADABOT_ACP_AGENTS_JSON`.

## Built-In Agents

The built-in ACP drivers are:

- `codex` via `codex-acp`
- `claude` via `claude-agent-acp`
- `pi` via `pi-acp`

The Pi ACP adapter requires the underlying `pi` executable. The project pins
`@earendil-works/pi-coding-agent`, which provides `node_modules/.bin/pi`, and
the built-in Pi driver passes that path to `pi-acp` with `PI_ACP_PI_COMMAND`.
This preserves the behavior the old Pi RPC harness had: prefer the local
project `pi` binary rather than requiring a global install.

## Runtime Contract

ACP provider messages are normalized into harness runtime events before they
reach the conversation and WhatsApp layers. The transport-facing contract is:

- assistant output reaches WhatsApp as `content` events
- stream chunks remain semantic stream events until the WhatsApp transport
  buffers and sends the final message
- tool lifecycle updates are projected as tool progress
- recognized tool flows keep grouped display and inspect state
- file changes are normalized as add/update/delete with diff data when
  available
- usage updates are normalized across snake_case and camelCase ACP payloads
- ACP permission and elicitation requests are bridged to chat-facing choices

## Protected Paths

Harness config can include:

```json
{
  "protectedPaths": ["package.json", "migrations/**", ".github/workflows/**"]
}
```

Protected path matches are resolved relative to the run workdir. When an ACP
agent attempts to change a protected file, Madabot asks for approval. If a
post-change event is denied, Madabot restores the previous file contents or
removes the newly-created file before the protected file-change is delivered to
the transport.

## Smoke Tests

Run real adapter initialize/session smokes:

```bash
pnpm exec node scripts/acp-adapter-smoke.js all
```

Run a minimal real prompt smoke for Codex:

```bash
pnpm exec node scripts/acp-adapter-smoke.js codex --prompt
```

These smokes use temporary workdirs and do not modify the repository. They may
require normal provider authentication and filesystem access outside strict test
sandboxes.
