# Rules

- Use JSDoc types and precise narrowing; avoid weak casts.
- Keep subsystem seams small, semantic, and explicit.
- When a request is vague or ambiguous, suggest concrete options or ask for clarification instead of assuming.
- Do not bypass seams, add special cases, or cut corners without confirming.
- When external payload shape matters, inspect a real payload before designing around it.
- For behavior changes, follow auditable red/green TDD:
  1. Add the focused regression test before changing production code.
  2. Run the focused test and confirm it fails for the expected reason; capture the command and failure in notes/commit context.
  3. Only then change production code to make the test pass.
  4. Re-run the focused test to confirm green.
  5. Run `pnpm type-check`, broader relevant tests, and usually `pnpm test`.
  6. Commit with the red command/failure, green command, and final verification in the commit body.
- Tests should prove user-valued behavior, not mirror implementation.
- For cross-seam behavior, test from the relevant start seam to the relevant end seam before adding narrower tests.
- For removals, prove the old behavior was covered and fails when removed before updating tests.
- For docs-only or instruction-only changes, skip code verification and commit.
