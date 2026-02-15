import assert from "node:assert/strict";

export default /** @type {defineAction} */ ((x) => x)({
  name: "show_info",
  command: "info",
  description: "Show information about the current chat",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  permissions: {
    autoExecute: true,
    useRootDb: true,
  },
  test_functions: [
    async function returns_chat_info(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id, is_enabled) VALUES ('act-info-1', true) ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        {
          chatId: "act-info-1",
          rootDb: db,
          senderIds: ["user-1"],
          content: [{ type: "text", text: "!info" }],
        },
        {},
      );
      assert.ok(result.includes("act-info-1"));
      assert.ok(result.includes("enabled"));
      assert.ok(result.includes("user-1"));
    },
  ],
  action_fn: async function ({ chatId, rootDb, senderIds, content }) {
    // Get chat enabled status
    const {
      rows: [chatInfo],
    } =
      await rootDb.sql`SELECT is_enabled FROM chats WHERE chat_id = ${chatId}`;

    if (!chatInfo) {
      throw new Error(`Chat ${chatId} does not exist.`);
    }

    const status = chatInfo.is_enabled ? "enabled" : "disabled";

    let info = `Chat Information:\n`;
    info += `- *Chat ID*: ${chatId}\n`;
    info += `- *Status*: ${status}\n`;
    info += `- *Sender IDs*: ${senderIds.join(", ")}\n`;
    info += `- *Your message*:
    \`\`\`
    ${JSON.stringify(content, null, 2)}
    \`\`\`
    `;

    return info;
  },
});
