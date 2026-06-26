# Investigate Sandboxed Child-Process Stdio Test Failures

## Subject

Investigate why some tests and probes that depend on nested child-process stdin/stdout behave differently under the Codex execution sandbox than outside it.

## Evidence

- User asked to add a todo for the stdin/stdout problems observed during test investigation.
- A trivial nested Node process with piped stdout exited with code `0` but produced an empty captured stdout buffer inside the default sandbox.
- The same nested stdout probe captured output outside the sandbox.
- Direct shell piping into `tests/fixtures/acp-mock-agent.js` produced an ACP `initialize` response.
- Running the ACP mock through the app's spawned child-process path inside the sandbox timed out on `initialize`.
- Running the same ACP harness test outside the sandbox completed successfully.
- Older done-task notes mention similar symptoms: sandboxed child-process pipes preventing ACP mock fixtures from receiving stdin or causing ACP stdin timeout patterns.

## Open Questions

- Is this caused by the Codex tool sandbox wrapper, Node child-process pipe behavior under that wrapper, or a repo-level test-runner interaction?
- Are stdin and stdout both affected, or is stdout capture failing first and making stdin delivery look broken?
- Can affected tests be reliably marked, skipped, or routed to escalated execution without hiding real ACP regressions?
- Should the repo provide a small diagnostic script that distinguishes sandbox stdio failure from app stdio failure?

## Constraints

- Do not treat sandbox-only failures as product bugs without an outside-sandbox comparison.
- Avoid changing production ACP stdio code unless a failing outside-sandbox reproduction exists.
- Keep the investigation focused on tests/probes that spawn child processes with piped stdio.

## Acceptance Criteria

- Reproduction matrix exists for default sandbox vs escalated execution.
- The affected test set is identified.
- Recommendation is recorded: fix repo code, adjust tests, document escalation requirement, or file/tooling issue.
- Any proposed test-runner change preserves real ACP stdio regression coverage.
