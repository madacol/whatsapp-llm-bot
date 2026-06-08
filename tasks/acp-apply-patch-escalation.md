# ACP Apply Patch Escalation

Status: Todo

## Goal

Determine whether the ACP adapter can configure or expose sandbox escalation specifically for the built-in `apply_patch` tool.

## Progress

- User asked whether the ACP adapter can configure this because Codex is running through ACP.
- Initial inspection started in `harnesses/acp.js`, `harnesses/acp-runner.js`, and `harnesses/acp-filesystem-capability.js`.
- Existing ACP filesystem requests can ask for sandbox escape approval for `fs/read_text_file` and `fs/write_text_file`; it is not yet clear whether any ACP adapter configuration can affect the built-in `apply_patch` tool.

## Open Questions

- Does the ACP protocol expose configuration for the built-in `apply_patch` tool, or only generic filesystem capabilities?
- Can this adapter intercept built-in `apply_patch`, or would it need a separate ACP filesystem/patch capability?
- Is the limitation in Codex's tool schema, this ACP adapter, or the underlying agent implementation?

## Dead Ends

- None recorded.
