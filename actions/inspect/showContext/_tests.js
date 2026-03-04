import assert from "node:assert/strict";

/** @type {ActionDbTestFn[]} */
export default [
async function returns_stored_context(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-ctx-1') ON CONFLICT DO NOTHING`;

      const llmContext = {
        model: "gpt-4.1",
        system_prompt: "You are a helpful bot.",
        messages: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi there!" },
        ],
        tools: ["run_javascript", "web_search"],
      };

      await db.sql`INSERT INTO messages(chat_id, sender_id, message_data, llm_context)
        VALUES ('act-ctx-1', 'bot', '{"role":"assistant","content":[{"type":"text","text":"Hi"}]}', ${JSON.stringify(llmContext)})`;

      const result = await action_fn({ chatId: "act-ctx-1", rootDb: db }, {});
      assert.ok(result.includes("gpt-4.1"), `Should include model, got: ${result.slice(0, 200)}`);
      assert.ok(result.includes("You are a helpful bot"), "Should include system prompt");
      assert.ok(result.includes("run_javascript"), "Should include tool names");
      assert.ok(result.includes("Hello"), "Should include message content");
    },
    async function returns_no_context_message(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-ctx-2') ON CONFLICT DO NOTHING`;
      const result = await action_fn({ chatId: "act-ctx-2", rootDb: db }, {});
      assert.ok(result.toLowerCase().includes("no context"), "Should indicate no context found");
    },
];
