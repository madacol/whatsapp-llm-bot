# Make `/compact` a generic ACP session command

## Task

Refactor the newly added `/compact` behavior so the app treats it as a generic ACP session command instead of a Codex-only command-layer special case.

## Evidence

- User asked whether `/compact` can be made more standard with no Codex special case.
- The prior implementation routed the request through generic ACP `session/compact`, but the command handler still gated on `sessionKind === "codex"` and used Codex-specific messages.

## Completion

- Removed the Codex-only command handler gate.
- Listed `/compact` for all ACP harnesses.
- Kept provider support as an opt-in ACP extension: the command calls generic `session/compact`, requires explicit acknowledgement, and reports unsupported providers clearly.
- Updated tests so non-Codex ACP providers can implement compaction through the same command path.

## Verification

- `pnpm test tests/acp-model-command.test.js`
- `pnpm test tests/acp-harness.test.js` with escalated child-process stdio permissions
- `pnpm run type-check`
- `pnpm run type-check:tests`
