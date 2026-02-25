# Rules

- Use JSDoc for all type annotations
- Apply Red/green TDD for ALL changes (features and bug fixes): always write a failing test first, verify it fails, then write the fix/implementation to make it pass. Never write the solution before the test
- Avoid weak typing like `@type {any}` casts. Use proper type guards and narrowing instead. Aspire to have strong and precise types everywhere
- After any change follow this:
  1. Make sure it passes type-checking (`npm run type-check`)
  2. test it (`npm test`)
  3. commit
+ After making a significant change:
  1. Identify anything that is worth refactoring
  2. Go through each refactor (if possible on parallel):
    1. Explain clearly the context and concern, include code snippets so I can understand and have the full picture
    2. Then give me options to decide what to do if you are not sure what's the best way to approach this



# Key Interfaces (`types.d.ts`)

Layered context system decoupling platform adapters from core logic:

1. **`IncomingContext`** — Normalized message produced by platform adapters (WhatsApp, Discord, etc). Message data + adapter capabilities (sendMessage, getAdminStatus).
2. **`Context`** — Bridge between `IncomingContext` and actions. Created in `index.js` — simplifies admin to boolean, adds header support to sendMessage/reply.
3. **`ActionContext`** — Base context for all actions. Built from `Context` with headers baked in, plus sessionDb, log, getActions.
4. **`ExtendedActionContext<P>`** — Extends `ActionContext` based on `PermissionFlags`. Actions declare permissions and receive corresponding capabilities. See `PermissionFlags` in `types.d.ts`.
5. **`Action<P>`** — Action definition: name, description, JSON Schema parameters, permissions, and `action_fn`.
