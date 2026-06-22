# Rules

- Use JSDoc types and precise narrowing; avoid weak casts.
- Keep subsystem seams small, semantic, and explicit.
- When a request is vague or ambiguous, suggest concrete options or ask for clarification instead of assuming.
- Do not bypass seams, add special cases, or cut corners without confirming.
- When external payload shape matters, inspect a real payload before designing around it.
- For behavior changes that preserve or alter supported behavior, prove red before production edits, then green, `pnpm type-check`, test, and commit with red/green verification noted.
- Tests should prove user-valued behavior, not mirror implementation.
- For cross-seam behavior, test from the relevant start seam to the relevant end seam before adding narrower tests.
- For removals of obsolete behavior, prove the old behavior was covered by deleting or moving the tests that asserted it. Do not add new characterization, boundary, or absence tests whose only purpose is to prove the removed path is gone. After deletion, rely on retained tests for retained behavior, and add new tests only when they protect a remaining user-valued contract or a seam that should not regress.
- For docs-only or instruction-only changes, skip code verification and commit.
