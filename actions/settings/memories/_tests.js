import assert from "node:assert/strict";

export default [
async function lists_all_memories_for_chat(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-mem-list-1') ON CONFLICT DO NOTHING`;
      await db.sql`DELETE FROM memories WHERE chat_id = 'act-mem-list-1'`;
      await db.sql`INSERT INTO memories (chat_id, content, search_text) VALUES ('act-mem-list-1', 'User likes cats', to_tsvector('english', 'User likes cats'))`;
      await db.sql`INSERT INTO memories (chat_id, content, search_text) VALUES ('act-mem-list-1', 'User birthday March 5', to_tsvector('english', 'User birthday March 5'))`;

      const mockClient = /** @type {import("openai").default} */ (/** @type {unknown} */ ({
        embeddings: { create: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }) },
      }));
      const result = await action_fn(
        { chatId: "act-mem-list-1", rootDb: db, llmClient: mockClient },
        {},
      );
      assert.ok(typeof result === "string");
      assert.ok(result.includes("cats"), `Should contain 'cats', got: ${result}`);
      assert.ok(result.includes("March 5"), `Should contain 'March 5', got: ${result}`);
      // Should show IDs
      assert.ok(result.includes("#"), `Should contain memory IDs with #, got: ${result}`);
    },

    async function lists_empty_when_no_memories(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-mem-list-2') ON CONFLICT DO NOTHING`;
      await db.sql`DELETE FROM memories WHERE chat_id = 'act-mem-list-2'`;

      const mockClient = /** @type {import("openai").default} */ (/** @type {unknown} */ ({
        embeddings: { create: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }) },
      }));
      const result = await action_fn(
        { chatId: "act-mem-list-2", rootDb: db, llmClient: mockClient },
        {},
      );
      assert.ok(typeof result === "string");
      assert.ok(
        result.toLowerCase().includes("no memories") || result.toLowerCase().includes("no saved"),
        `Expected 'no memories', got: ${result}`,
      );
    },

    async function deletes_memory_by_id(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-mem-del-1') ON CONFLICT DO NOTHING`;
      await db.sql`DELETE FROM memories WHERE chat_id = 'act-mem-del-1'`;
      const { rows: [{ id }] } = await db.sql`
        INSERT INTO memories (chat_id, content, search_text)
        VALUES ('act-mem-del-1', 'To delete', to_tsvector('english', 'To delete'))
        RETURNING id
      `;

      const mockClient = /** @type {import("openai").default} */ (/** @type {unknown} */ ({
        embeddings: { create: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }) },
      }));
      const result = await action_fn(
        { chatId: "act-mem-del-1", rootDb: db, llmClient: mockClient },
        { subcommand: "delete", args: String(id) },
      );
      assert.ok(typeof result === "string");
      assert.ok(result.toLowerCase().includes("deleted"), `Expected 'deleted' in result, got: ${result}`);

      const { rows } = await db.sql`SELECT * FROM memories WHERE id = ${id}`;
      assert.equal(rows.length, 0, "Memory should be deleted");
    },

    async function returns_error_for_invalid_delete_id(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-mem-del-2') ON CONFLICT DO NOTHING`;

      const mockClient = /** @type {import("openai").default} */ (/** @type {unknown} */ ({
        embeddings: { create: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }) },
      }));
      const result = await action_fn(
        { chatId: "act-mem-del-2", rootDb: db, llmClient: mockClient },
        { subcommand: "delete", args: "abc" },
      );
      assert.ok(typeof result === "string");
      assert.ok(
        result.toLowerCase().includes("invalid") || result.toLowerCase().includes("number"),
        `Expected error about invalid id, got: ${result}`,
      );
    },

    async function returns_not_found_for_nonexistent_id(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-mem-del-3') ON CONFLICT DO NOTHING`;

      const mockClient = /** @type {import("openai").default} */ (/** @type {unknown} */ ({
        embeddings: { create: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }) },
      }));
      const result = await action_fn(
        { chatId: "act-mem-del-3", rootDb: db, llmClient: mockClient },
        { subcommand: "delete", args: "99999" },
      );
      assert.ok(typeof result === "string");
      assert.ok(
        result.toLowerCase().includes("not found") || result.toLowerCase().includes("no memory"),
        `Expected 'not found' in result, got: ${result}`,
      );
    },

    async function searches_memories_by_text(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-mem-search-1') ON CONFLICT DO NOTHING`;
      await db.sql`DELETE FROM memories WHERE chat_id = 'act-mem-search-1'`;
      await db.sql`INSERT INTO memories (chat_id, content, search_text)
        VALUES ('act-mem-search-1', 'User likes cats and kittens', to_tsvector('english', 'User likes cats and kittens'))`;
      await db.sql`INSERT INTO memories (chat_id, content, search_text)
        VALUES ('act-mem-search-1', 'User birthday is March 5', to_tsvector('english', 'User birthday is March 5'))`;

      // Use a failing embedding client to force FTS path
      const mockClient = /** @type {import("openai").default} */ (/** @type {unknown} */ ({
        embeddings: { create: async () => { throw new Error("fail"); } },
      }));
      const result = await action_fn(
        { chatId: "act-mem-search-1", rootDb: db, llmClient: mockClient },
        { subcommand: "search", args: "cats" },
      );
      assert.ok(typeof result === "string");
      assert.ok(result.includes("cats"), `Should find 'cats' memory, got: ${result}`);
    },

    async function returns_no_results_for_unmatched_search(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-mem-search-2') ON CONFLICT DO NOTHING`;
      await db.sql`DELETE FROM memories WHERE chat_id = 'act-mem-search-2'`;

      const mockClient = /** @type {import("openai").default} */ (/** @type {unknown} */ ({
        embeddings: { create: async () => { throw new Error("fail"); } },
      }));
      const result = await action_fn(
        { chatId: "act-mem-search-2", rootDb: db, llmClient: mockClient },
        { subcommand: "search", args: "elephants" },
      );
      assert.ok(typeof result === "string");
      assert.ok(
        result.toLowerCase().includes("no") && result.toLowerCase().includes("found"),
        `Expected 'no results found', got: ${result}`,
      );
    },
];
