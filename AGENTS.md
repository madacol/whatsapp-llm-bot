# Rules

- Use JSDoc for all type annotations
- Apply red/green TDD for ALL changes (features and bug fixes): always write a failing test first, verify it fails, then write the fix/implementation to make it pass. Never write the solution before the test. Treat the tests as the spec, user must be aware what will be tested and what won't and why
- Avoid weak typing like `@type {any}` casts. Use proper type guards and narrowing instead. Aspire to have strong and precise types everywhere
- After making any change, commit! Then if there's any refactor worth doing, explain why and how it can be done
- Before cutting corners, ask yourself why do you need to do this, and what needs to be done to avoid this. If you still think cutting this corner is still the best course of action, explain thoroughly to the user and let them decide how to continue with the plan
