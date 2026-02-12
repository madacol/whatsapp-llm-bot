---
name: create-action
description: Create a new bot action with proper structure, permissions, and types
---

# /create-action — Create a new bot action

## Boilerplate

Every action file in `actions/` uses this pattern:

```js
export default /** @type {defineAction} */ ((x) => x)({
  name: "snake_case_name",
  command: "bang-command",       // optional — enables `!bang-command` usage
  description: "One-line description for the LLM function picker",
  parameters: {
    type: "object",
    properties: {
      paramName: {
        type: "string",        // JSON Schema types: string, number, boolean, object, array
        description: "Shown to the LLM when it calls this function",
      },
    },
    required: ["paramName"],   // omit or [] if all optional
  },
  permissions: {
    autoExecute: true,         // required for now — confirmation UI not implemented
  },
  action_fn: async function (context, params) {
    // ...
    return "result shown to user (or fed back to LLM)";
  },
});
```

## Permission Flags (`PermissionFlags` in `types.d.ts`)

Declare in `permissions` — each flag injects extra capabilities into the action context:

| Flag             | Injects into context          | Purpose                                              |
|------------------|-------------------------------|------------------------------------------------------|
| `autoExecute`    | —                             | Execute without confirmation (required for now)       |
| `autoContinue`   | —                             | LLM continues generating after this action returns    |
| `requireAdmin`   | —                             | Restrict to group admins / any user in private chats  |
| `requireMaster`  | —                             | Restrict to `MASTER_ID` users (env var)               |
| `useChatDb`      | `chatDb: PGlite`             | Per-action PGlite database (`./pgdata/<actionName>`)  |
| `useRootDb`      | `rootDb: PGlite`             | Shared root database (`./pgdata/root`)                |
| `useLlm`         | `callLlm: CallLlm`          | Call the LLM from within the action                   |

## Base `ActionContext` (always available)

```
chatId, senderIds, content, getIsAdmin, sessionDb, getActions, log, sendMessage, reply
```

See `types.d.ts` for full signatures.

## Example: action with database and messaging

```js
export default /** @type {defineAction} */ ((x) => x)({
  name: "message_stats",
  command: "stats",
  description: "Show message count for the current chat",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  permissions: {
    autoExecute: true,
    useRootDb: true,
  },
  action_fn: async function ({ chatId, rootDb, sendMessage }, _params) {
    const { rows } = await rootDb.sql`
      SELECT COUNT(*) as count FROM messages WHERE chat_id = ${chatId}
    `;
    const count = rows[0].count;
    await sendMessage(`This chat has ${count} messages.`);
    return `${count} messages in chat ${chatId}`;
  },
});
```

## Rules
- Use JSDoc for all type annotations (no TypeScript syntax in `.js` files)
- File name should match the action name in camelCase (e.g., `messageStats.js` for `message_stats`)
- Always set `autoExecute: true` — confirmation flow is not yet implemented
- Run `npm run type-check` after creating the action
