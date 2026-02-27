import assert from "node:assert/strict";
import { saveMemory } from "../../memory.js";

export default /** @type {defineAction} */ ((x) => x)({
  name: "save_memory",
  description:
    "Save a note that helps you understand this user better so future responses " +
    "are faster and more accurate. Prioritize: corrections the user made, " +
    "preferred response styles, how they phrase recurring requests, implicit " +
    "preferences revealed over time, and context that resolves ambiguity " +
    '(e.g. "User prefers concise bullet points over long explanations", ' +
    '"When user asks about \'the project\' they mean the React dashboard", ' +
    '"User corrected: always use metric units, not imperial"). ' +
    "Skip trivia or small-talk facts unless they clearly help predict what " +
    "the user will need.",
  parameters: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description:
          "A concise note capturing a pattern, preference, or correction " +
            "that helps predict what the user wants " +
            '(e.g. "User always wants code examples in Python, not JS")',
      },
    },
    required: ["content"],
  },
  permissions: {
    autoExecute: true,
    autoContinue: true,
    silent: true,
    useRootDb: true,
    useLlm: true,
  },
  /** @param {{content?: string}} params */
  formatToolCall: ({ content }) => `Remembering "${content}"`,
  test_functions: [
    async function saves_memory_and_returns_confirmation(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-savemem-1') ON CONFLICT DO NOTHING`;
      const mockClient = /** @type {import("openai").default} */ (/** @type {unknown} */ ({
        embeddings: {
          create: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
        },
      }));

      const result = await action_fn(
        { chatId: "act-savemem-1", rootDb: db, llmClient: mockClient },
        { content: "User likes cats" },
      );

      assert.ok(typeof result === "string");
      assert.ok(result.toLowerCase().includes("saved"), `Expected "saved" in result, got: ${result}`);

      // Verify row exists in memories table
      const { rows } = await db.sql`SELECT * FROM memories WHERE chat_id = 'act-savemem-1'`;
      assert.ok(rows.length > 0, "Memory should be stored in DB");
      assert.equal(rows[0].content, "User likes cats");
    },

    async function rejects_empty_content(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-savemem-2') ON CONFLICT DO NOTHING`;
      const mockClient = /** @type {import("openai").default} */ (/** @type {unknown} */ ({
        embeddings: {
          create: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
        },
      }));

      const result = await action_fn(
        { chatId: "act-savemem-2", rootDb: db, llmClient: mockClient },
        { content: "  " },
      );

      assert.ok(typeof result === "string");
      assert.ok(
        result.toLowerCase().includes("empty") || result.toLowerCase().includes("content"),
        `Expected error about empty content, got: ${result}`,
      );
    },

    async function stores_search_text_for_fts(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-savemem-3') ON CONFLICT DO NOTHING`;
      const mockClient = /** @type {import("openai").default} */ (/** @type {unknown} */ ({
        embeddings: {
          create: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
        },
      }));

      await action_fn(
        { chatId: "act-savemem-3", rootDb: db, llmClient: mockClient },
        { content: "User works at Acme Corp" },
      );

      const { rows } = await db.sql`SELECT search_text FROM memories WHERE chat_id = 'act-savemem-3'`;
      assert.ok(rows.length > 0);
      assert.ok(rows[0].search_text != null, "search_text should be set");
    },
  ],
  action_fn: async function ({ chatId, rootDb, llmClient }, params) {
    const content = params.content?.trim();
    if (!content) {
      return "Cannot save empty content. Please provide a note to remember.";
    }

    const id = await saveMemory(rootDb, llmClient, chatId, content);
    return `Memory saved (id: ${id}).`;
  },
});
