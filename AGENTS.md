# Rules

- Use JSDoc for all type annotations
- Avoid weak typing like `@type {any}` casts. Use proper type guards and narrowing instead. Aspire to have strong and precise types everywhere
- After making any change, commit! Then if there's any refactor worth doing, explain why and how it can be done
- Before cutting corners, ask yourself why do you need to do this, and what needs to be done to avoid this. If you still think cutting this corner is still the best course of action, explain thoroughly to the user and let them decide how to continue with the plan

## Testing
- Apply red/green TDD for ALL changes: failing test first, then implementation. Treat tests as the spec — tell the user what will and won't be tested and why
- Tests must verify real behavior, not mirror the implementation. Prefer integration tests over unit tests for glue code; reserve unit tests for pure functions with edge cases
- Every test must protect against a specific user-facing bug. If you can't name the consequence of failure, don't write the test
