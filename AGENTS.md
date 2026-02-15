# Rules
- Use JSDoc for all type annotations
- Run `npm run type-check` after any code change
- Red/green TDD for ALL changes (features and bug fixes): always write a failing test first, verify it fails, then write the fix/implementation to make it pass. Never write the solution before the test.
- **Strong typing**: Strongly avoid weak typing like `@type {any}` casts. Use proper type guards and narrowing instead. Aspire to have strong, precise types everywhere.

# Key Interfaces (`types.d.ts`)

Layered context system decoupling platform adapters from core logic:

1. **`IncomingContext`** — Normalized message produced by platform adapters (WhatsApp, Discord, etc). Message data + adapter capabilities (sendMessage, getAdminStatus).
2. **`Context`** — Bridge between `IncomingContext` and actions. Created in `index.js` — simplifies admin to boolean, adds header support to sendMessage/reply.
3. **`ActionContext`** — Base context for all actions. Built from `Context` with headers baked in, plus sessionDb, log, getActions.
4. **`ExtendedActionContext<P>`** — Extends `ActionContext` based on `PermissionFlags`. Actions declare permissions and receive corresponding capabilities. See `PermissionFlags` in `types.d.ts`.
5. **`Action<P>`** — Action definition: name, description, JSON Schema parameters, permissions, and `action_fn`.
