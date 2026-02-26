# Rules

- Use JSDoc for all type annotations
- Apply red/green TDD for ALL changes (features and bug fixes): always write a failing test first, verify it fails, then write the fix/implementation to make it pass. Never write the solution before the test. Treat the tests as the spec, user must be aware what will be tested and what won't and why
- Avoid weak typing like `@type {any}` casts. Use proper type guards and narrowing instead. Aspire to have strong and precise types everywhere
- After a plan has been set, follow this:
  1. Propose spec for tests, and ask user to confirm
  2. For each approved spec, run a subagent in a worktree to implement tests and functionality. If they don't overlap, run them in parallel:
    1. Make sure code passes type-checking (`npm run type-check`)
    2. test it (`npm test`)
    3. commit
  3. Merge to main branch each succesfull change
- After making a significant change, look for refactoring opportunities
