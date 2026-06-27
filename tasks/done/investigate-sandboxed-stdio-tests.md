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

## Investigation Result

The failures reproduce as a Codex execution-sandbox stdio problem, not as a product ACP stdio bug.

### Reproduction Matrix

- Default sandbox synthetic child stdout probe:
  - Command shape: parent spawns `process.execPath` with `stdio: ["ignore", "pipe", "pipe"]`; child writes `child-out`.
  - Result: child exits with `code: 0`, but parent captures `out: ""`.
- Escalated synthetic child stdout probe:
  - Same command shape outside the sandbox.
  - Result: child exits with `code: 0`, parent captures `out: "child-out"`.
- Default sandbox ACP mock initialize probe:
  - Parent spawns `tests/fixtures/acp-mock-agent.js`, writes JSON-RPC `initialize` to child stdin, waits for child stdout.
  - Result: timed out after 1000ms with `out: ""`, `err: ""`.
- Escalated ACP mock initialize probe:
  - Same probe outside the sandbox.
  - Result: received a valid ACP `initialize` JSON-RPC response.
- Default sandbox focused ACP harness test:
  - `pnpm test --test-name-pattern "runs an ACP stdio agent" tests/acp-harness.test.js`
  - Result: `runs an ACP stdio agent and emits canonical runtime events` timed out after roughly 30s and left the process alive until manually terminated.
- Escalated focused ACP harness test:
  - Same command outside the sandbox.
  - Result: passed in roughly 0.15s.
- Default sandbox focused ACP client unit suite:
  - `pnpm test tests/acp-client.test.js --test-name-pattern "merges supplied environment"`
  - Result: passed. This keeps the affected category narrower than all child-process tests.

### Affected Test Set

Tests that use `tests/fixtures/acp-mock-agent.js` and depend on ACP JSON-RPC over child stdin/stdout are affected under the default sandbox:

- `tests/acp-harness.test.js`
- `tests/acp-payload-to-whatsapp.test.js`
- `tests/e2e-adapter.test.js`
- `tests/harness-registry.test.js`

The affected category is vertical/full-harness ACP mock tests. The ACP client unit tests that use inline Node fixture code currently pass under the default sandbox.

### Recommendation

- Do not change production ACP stdio code for this symptom without an outside-sandbox failure.
- Do not skip or weaken the ACP mock vertical tests; they protect real ACP regression coverage.
- Run the affected ACP mock vertical tests with sandbox escalation when using the Codex execution sandbox.
- Treat the default-sandbox timeout as a tooling/sandbox limitation. If this becomes frequent, add a small diagnostic script or test-runner note that checks nested child stdout capture before running ACP mock vertical suites.

## Completion Notes

- No production code was changed.
- The task was closed as an investigation with a concrete matrix and an escalation recommendation.

## Verification

- Sandboxed probes reproduced empty child stdout and ACP mock initialize timeout.
- Escalated probes captured child stdout and ACP mock initialize output.
- `pnpm test --test-name-pattern "runs an ACP stdio agent" tests/acp-harness.test.js` passed with escalation.
- `pnpm test tests/acp-client.test.js --test-name-pattern "merges supplied environment"` passed in the default sandbox.

## Status

Done.
