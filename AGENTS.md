# Rules

- Use JSDoc types and precise narrowing; avoid weak casts.
- Keep subsystem seams small, semantic, and explicit.
- When a request is vague or ambiguous, suggest concrete options or ask for clarification instead of assuming.
- Do not bypass seams, add special cases, or cut corners without confirming.
- When external payload shape matters, inspect a real payload before designing around it.
- For behavior changes that preserve or alter supported behavior, prove red before production edits, then green, `pnpm type-check`, test, and commit with red/green verification noted.
- Tests should prove user-valued behavior, not mirror implementation.
- For cross-seam behavior, test from the relevant start seam to the relevant end seam before adding narrower tests.
- For removals of obsolete behavior, prefer deleting code over adding characterization or boundary tests for the removed path. Delete or update tests that only assert removed behavior, rely on existing coverage for retained behavior, and add new tests only when they protect a remaining user-valued contract or a seam that should not regress.
- For docs-only or instruction-only changes, skip code verification and commit.
