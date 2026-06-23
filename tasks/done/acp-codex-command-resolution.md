# ACP Codex Command Resolution

## Context

- Production runtime log on 2026-06-23 showed the Codex ACP turn reaching:
  - `Opening ACP connection { command: 'codex-acp', ... }`
  - `ACP initialize request starting { command: 'codex-acp', ... }`
  - then process-fatal `Error: spawn codex-acp ENOENT`
- In current local code, `openAcpConnection()` already awaits the child `spawn` event and rejects missing commands with `Failed to start ACP command ... code=ENOENT`.
- The production log did not show the handled `ACP child process failed to start` warning, and it logged initialize starting after open. Later investigation found the package-level root cause: ACP runtime executables were declared under `devDependencies`, so production-style installs did not include `codex-acp`.

## Completed

- Added a direct known-package fallback so `codex-acp` resolves through installed `@agentclientprotocol/codex-acp` before falling back to shell lookup.
- Moved ACP runtime executable packages from `devDependencies` to `dependencies` so production installs include the transports:
  - `@agentclientprotocol/claude-agent-acp`
  - `@agentclientprotocol/codex-acp`
  - `@earendil-works/pi-coding-agent`
  - `pi-acp`
- Added a regression test that keeps those runtime driver packages out of `devDependencies`.
- Kept built-in Codex config as semantic `command: "codex-acp"` so persisted chat config stays portable.
- Added `resolvedCommand` to ACP runner open/initialize logs so production logs show the actual executable path attempted.
- Renamed the existing resolver test to describe the durable contract: repo-local executable resolution instead of shell lookup.

## Verification

- `pnpm test tests/acp-client.test.js tests/acp-agents.test.js`
- `pnpm test tests/acp-harness.test.js` outside sandbox; the sandboxed run hit the known child stdin timeout pattern and was stopped.
- `pnpm type-check`
- `pnpm install --lockfile-only --offline`
- `pnpm install --offline`
- `pnpm list --depth 0 --prod`
