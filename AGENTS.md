# Rules

- Use JSDoc for all type annotations
- Avoid weak typing like `@type {any|unknown}` casts. Use proper type guards and narrowing instead. Aspire to have strong and precise types everywhere
- Before making a non-trivial change, start with a very high-level plan, give the user a chance to redirect, then expand into detailed steps, edge cases, and execution only after the direction is clear
- Before adding special cases, ask the user to confirm that the special-case path is actually desired
- After making a change that can affect runtime behavior, `pnpm type-check`, then test and then commit!. For docs-only or instruction-only changes, skip code verification and just commit. Then if there's any refactor worth doing, explain why and how it can be done
- When refactoring, identify the main seams between subsystems and reduce each seam to a small semantic boundary
- Before cutting corners, ask yourself why do you need to do this, and what needs to be done to avoid this. If you still think cutting this corner is still the best course of action, explain thoroughly to the user and let them decide how to continue with the plan
- When implementation depends on an external payload or event format from an LLM API, WhatsApp/Baileys, an SDK, or an app server, make an empirical request first and inspect the full real response before proposing the plan. Do not rely on docs, assumptions, or partial samples when that format is a key dependency

## Testing
- Apply red/green TDD
- Tests should catch regressions, not mirror implementation. Ask: "if this test fails, what real bug did it catch?" If there's no clear answer, skip the test
- For behavioral changes (bug fixes, new features), write a failing test first, then implement. For refactors and trivial changes, existing tests passing is sufficient
- Prefer integration tests for glue code, unit tests for pure functions with edge cases. Test at the boundary where bugs would be noticed
- Save tests output to a temporary file so you can grep|head|tail later because the output is usually long

## Adapter Design
- The adapter should expose semantic primitives (select, confirm, send) not platform event callbacks
- Platform mechanics (polls, reactions, message editing) are implementation details — callers should not need to know about them
- When sending a message, the returned handle should give the caller control over the full lifecycle of that message
