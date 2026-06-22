# ACP Apply Patch Escalation

Status: Done

## Goal

Determine whether the ACP adapter can configure or expose sandbox escalation specifically for the built-in `apply_patch` tool.

## Progress

- User asked whether the ACP adapter can configure this because Codex is running through ACP.
- Initial inspection started in `harnesses/acp.js`, `harnesses/acp-runner.js`, and `harnesses/acp-filesystem-capability.js`.
- Existing ACP filesystem requests can ask for sandbox escape approval for `fs/read_text_file` and `fs/write_text_file`.
- `harnesses/acp-runner.js` passes `sandboxMode`, `approvalPolicy`, `approvalsReviewer`, and `additionalDirectories` to the ACP agent in session metadata.
- `harnesses/acp.js` exposes chat commands for ACP permissions and approval policy, so the adapter can configure the agent's general sandbox and approval mode.
- `harnesses/acp-filesystem-capability.js` can ask for sandbox escape approval for client-handled ACP filesystem requests.
- `harnesses/acp-runtime-model.js` only parses completed `apply_patch` tool-call payloads into file-change events; this is presentation/reconciliation after the tool call, not interception or escalation control for the built-in tool.

## Conclusion

The ACP adapter can configure the ACP agent's general sandbox and approval policy, and it can approve sandbox escapes for ACP `fs/*` requests it handles. It does not currently expose a setting that makes the built-in `apply_patch` tool itself request sandbox escalation; that behavior appears to live in the underlying Codex tool schema/runtime rather than this adapter.

## Open Questions

- Whether to implement a separate ACP patch/filesystem capability or command workaround if user wants escalation-capable patch edits outside the built-in `apply_patch` path.

## Dead Ends

- None recorded.
