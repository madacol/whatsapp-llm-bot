# Rules

- Use JSDoc types and precise narrowing; avoid weak casts.
- Keep subsystem seams small, semantic, and explicit.
- When a request is vague or ambiguous, ask for clarification instead of assuming.
- Do not bypass seams, add special cases, or cut corners without confirming.
- When external payload shape matters, inspect a real payload before designing around it.
- For behavior changes, use red/green TDD, then `pnpm type-check`, test, and commit.
- Tests should prove user-valued behavior, not mirror implementation.
- For cross-seam behavior, test from the relevant start seam to the relevant end seam before adding narrower tests.
- For removals, prove the old behavior was covered and fails when removed before updating tests.
- For docs-only or instruction-only changes, skip code verification and commit.
