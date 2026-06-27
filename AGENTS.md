# Rules

- Use JSDoc types and precise narrowing; avoid weak casts.
- Keep subsystem seams small, semantic, and explicit.
- When a request is vague or ambiguous, suggest concrete options or ask for clarification instead of assuming.
- Do not bypass seams, add special cases, or cut corners without confirming.
- When external payload shape matters, inspect a real payload before designing around it.
- For behavior changes that preserve or alter supported behavior, prove red before production edits, then green, `pnpm type-check`, test, and commit with red/green verification noted.
- Tests should prove user-valued behavior, not mirror implementation.
- For cross-seam behavior, test from the relevant start seam to the relevant end seam before adding narrower tests.
- New vertical slice and end-to-end tests should use the scenario-runner pattern in `tests/scenario-runner.js`: plain JavaScript step arrays, composite modules for repeated setup, real capture records from logs or smoke-generated capture output, and plain assertions over scenario context. Prefer adding useful new scenario tests before migrating existing long tests; migrate existing tests only after the pattern has proven a clear readability and maintenance benefit across several new tests.
- For removals of obsolete behavior, identify and record the existing tests that prove the behavior being removed. Run those tests green first when practical, remove the feature, then run the same tests and confirm they fail for the expected reason. After that red proof, delete or update the tests that asserted removed behavior. Do not add or keep characterization, boundary, or absence tests whose only purpose is to prove the removed path is gone. Absence tests are appropriate only when the absence itself is a durable user-valued, safety, or architecture invariant. Add new tests only when they protect a remaining user-valued contract or a seam that should not regress.
- Use the `manage-tasks` skill for durable task tracking. This repo's task index is `tasks/todo.md`; task files live under `tasks/`; completed task files move to `tasks/done/` with a concise entry in `tasks/done/done.md`.
- For docs-only or instruction-only changes, skip code verification and commit.
