# ACP Codex Command Resolution

## Context

- Production runtime log on 2026-06-23 showed the Codex ACP turn reaching:
  - `Opening ACP connection { command: 'codex-acp', ... }`
  - `ACP initialize request starting { command: 'codex-acp', ... }`
  - then process-fatal `Error: spawn codex-acp ENOENT`
- In current local code, `openAcpConnection()` already awaits the child `spawn` event and rejects missing commands with `Failed to start ACP command ... code=ENOENT`.
- The production log did not show the handled `ACP child process failed to start` warning, and it logged initialize starting after open. That suggests the live daemon was on an older launcher or different process image, but the resolver/logging was still hardened.

## Completed

- Added a direct known-package fallback so `codex-acp` resolves through installed `@agentclientprotocol/codex-acp` before falling back to shell lookup.
- Kept built-in Codex config as semantic `command: "codex-acp"` so persisted chat config stays portable.
- Added `resolvedCommand` to ACP runner open/initialize logs so production logs show the actual executable path attempted.
- Renamed the existing resolver test to describe the durable contract: repo-local executable resolution instead of shell lookup.

## Verification

- `pnpm test tests/acp-client.test.js tests/acp-agents.test.js`
- `pnpm test tests/acp-harness.test.js` outside sandbox; the sandboxed run hit the known child stdin timeout pattern and was stopped.
- `pnpm type-check`
