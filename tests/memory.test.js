process.env.TESTING = "1";

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { initStore } from "../store.js";
import {
  extractTextFromMessage,
  generateEmbedding,
  saveMemory,
  findMemories,
  listMemories,
  deleteMemory,
  formatMemoriesContext,
} from "../memory.js";

/** @type {PGlite} */
let db;
/** @type {Awaited<ReturnType<typeof initStore>>} */
let store;

before(async () => {
  db = new PGlite("memory://", { extensions: { vector } });
  store = await initStore(db);

  // Create memories table (will be in store.js after Phase 1A merge)
  await db.sql`
    CREATE TABLE IF NOT EXISTS memories (
      id SERIAL PRIMARY KEY,
      chat_id VARCHAR(50) REFERENCES chats(chat_id),
      content TEXT NOT NULL,
      embedding vector,
      search_text tsvector,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `;
  await db.sql`CREATE INDEX IF NOT EXISTS idx_memories_search_text ON memories USING gin (search_text)`;
});

// ═══════════════════════════════════════════════════════════════════
// extractTextFromMessage
// ═══════════════════════════════════════════════════════════════════
describe("extractTextFromMessage", () => {
  it("includes tool call representation for assistant messages", () => {
    /** @type {AssistantMessage} */
    const msg = {
      role: "assistant",
      content: [
        { type: "text", text: "Let me search." },
        { type: "tool", tool_id: "c1", name: "web_search", arguments: '{"query":"test"}' },
      ],
    };
    const text = extractTextFromMessage(msg);
    assert.ok(text.includes("Let me search."));
    assert.ok(text.includes("[tool: web_search("));
    assert.ok(text.includes("test"));
  });

  it("extracts text from tool result messages", () => {
    /** @type {ToolMessage} */
    const msg = {
      role: "tool",
      tool_id: "c1",
      content: [{ type: "text", text: "Search results: found 3 items" }],
    };
    assert.equal(extractTextFromMessage(msg), "Search results: found 3 items");
  });

  it("extracts text from quoted content blocks", () => {
    /** @type {UserMessage} */
    const msg = {
      role: "user",
      content: [
        { type: "quote", content: [{ type: "text", text: "original message" }] },
        { type: "text", text: "my reply" },
      ],
    };
    const text = extractTextFromMessage(msg);
    assert.ok(text.includes("original message"));
    assert.ok(text.includes("my reply"));
  });

});

// ═══════════════════════════════════════════════════════════════════
// generateEmbedding
// ═══════════════════════════════════════════════════════════════════
describe("generateEmbedding", () => {
  it("returns embedding array on success", async () => {
    const mockEmbedding = [0.1, 0.2, 0.3];
    const mockClient = /** @type {import("openai").default} */ ({
      embeddings: {
        create: async () => ({ data: [{ embedding: mockEmbedding }] }),
      },
    });

    const result = await generateEmbedding(mockClient, "test text for embedding");
    assert.deepEqual(result, mockEmbedding);
  });

  it("returns null for short text (< 10 chars)", async () => {
    const mockClient = /** @type {import("openai").default} */ ({
      embeddings: { create: async () => { throw new Error("should not be called"); } },
    });

    const result = await generateEmbedding(mockClient, "hi");
    assert.equal(result, null);
  });

  it("returns null for empty text", async () => {
    const mockClient = /** @type {import("openai").default} */ ({
      embeddings: { create: async () => { throw new Error("should not be called"); } },
    });

    const result = await generateEmbedding(mockClient, "");
    assert.equal(result, null);
  });

  it("returns null on API failure", async () => {
    const mockClient = /** @type {import("openai").default} */ ({
      embeddings: { create: async () => { throw new Error("API error"); } },
    });

    const result = await generateEmbedding(mockClient, "valid text for embedding");
    assert.equal(result, null);
  });
});

// ═══════════════════════════════════════════════════════════════════
// saveMemory
// ═══════════════════════════════════════════════════════════════════
describe("saveMemory", () => {
  it("stores memory with embedding when embedding succeeds", async () => {
    await store.createChat("mem-save-1");
    const mockEmbedding = [0.1, 0.2, 0.3];
    const mockClient = /** @type {import("openai").default} */ ({
      embeddings: { create: async () => ({ data: [{ embedding: mockEmbedding }] }) },
    });

    const id = await saveMemory(db, mockClient, "mem-save-1", "User likes cats");

    const { rows: [row] } = await db.sql`SELECT * FROM memories WHERE id = ${id}`;
    assert.equal(row.content, "User likes cats");
    assert.ok(row.embedding, "embedding should be set");
    assert.ok(row.search_text, "search_text should be set");
  });

  it("stores memory with search_text only when embedding fails", async () => {
    await store.createChat("mem-save-2");
    const mockClient = /** @type {import("openai").default} */ ({
      embeddings: { create: async () => { throw new Error("API error"); } },
    });

    const id = await saveMemory(db, mockClient, "mem-save-2", "User prefers dark mode settings");

    const { rows: [row] } = await db.sql`SELECT * FROM memories WHERE id = ${id}`;
    assert.equal(row.content, "User prefers dark mode settings");
    assert.equal(row.embedding, null, "embedding should be null");
    assert.ok(row.search_text, "search_text should be set");
  });

  it("returns the inserted memory id", async () => {
    await store.createChat("mem-save-3");
    const mockClient = /** @type {import("openai").default} */ ({
      embeddings: { create: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }) },
    });

    const id = await saveMemory(db, mockClient, "mem-save-3", "User's birthday is March 5");
    assert.equal(typeof id, "number");
    assert.ok(id > 0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// findMemories
// ═══════════════════════════════════════════════════════════════════
describe("findMemories", () => {
  /**
   * Helper: generate a deterministic "embedding" vector.
   * @param {number} seed
   * @param {number} dims
   * @returns {number[]}
   */
  function fakeEmbedding(seed, dims = 3) {
    const vec = [];
    for (let i = 0; i < dims; i++) {
      vec.push(Math.sin(seed + i));
    }
    const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    return vec.map(v => v / mag);
  }

  before(async () => {
    const chatId = "mem-find-1";
    await store.createChat(chatId);

    const memories = [
      "User likes cats and kittens",
      "User's favorite color is blue",
      "User works as a software engineer",
    ];

    for (let i = 0; i < memories.length; i++) {
      const emb = fakeEmbedding(i);
      await db.sql`
        INSERT INTO memories (chat_id, content, embedding, search_text)
        VALUES (${chatId}, ${memories[i]}, ${JSON.stringify(emb)}::vector, to_tsvector('english', ${memories[i]}))
      `;
    }
  });

  it("finds memories by embedding similarity", async () => {
    function fakeEmbedding2(seed, dims = 3) {
      const vec = [];
      for (let i = 0; i < dims; i++) vec.push(Math.sin(seed + i));
      const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
      return vec.map(v => v / mag);
    }
    const queryEmb = fakeEmbedding2(0); // similar to first memory
    const mockClient = /** @type {import("openai").default} */ ({
      embeddings: { create: async () => ({ data: [{ embedding: queryEmb }] }) },
    });

    const results = await findMemories(db, mockClient, "mem-find-1", "cats and animals", { minSimilarity: 0 });

    assert.ok(results.length > 0, "Should find at least one memory");
    // Results should be sorted by descending similarity
    if (results.length > 1) {
      assert.ok(Number(results[0].similarity) >= Number(results[1].similarity));
    }
  });

  it("scopes search to chatId", async () => {
    await store.createChat("mem-find-other");
    await db.sql`
      INSERT INTO memories (chat_id, content, embedding, search_text)
      VALUES ('mem-find-other', 'Other chat memory', ${JSON.stringify(fakeEmbedding(0))}::vector, to_tsvector('english', 'Other chat memory'))
    `;

    const mockClient = /** @type {import("openai").default} */ ({
      embeddings: { create: async () => ({ data: [{ embedding: fakeEmbedding(0) }] }) },
    });

    const results = await findMemories(db, mockClient, "mem-find-1", "test", { minSimilarity: 0 });
    for (const r of results) {
      assert.equal(r.chat_id, "mem-find-1");
    }
  });

  it("falls back to FTS when embedding fails", async () => {
    const failClient = /** @type {import("openai").default} */ ({
      embeddings: { create: async () => { throw new Error("API error"); } },
    });

    const results = await findMemories(db, failClient, "mem-find-1", "cats", { minSimilarity: 0 });
    assert.ok(results.length > 0, "Should find results via FTS");
    assert.ok(results.some(r => r.content.includes("cats")));
  });

  it("respects limit", async () => {
    // Insert more memories first
    await store.createChat("mem-find-limit");
    for (let i = 0; i < 5; i++) {
      await db.sql`
        INSERT INTO memories (chat_id, content, search_text)
        VALUES ('mem-find-limit', ${'Memory number ' + i + ' about testing limits for real'}, to_tsvector('english', ${'Memory number ' + i + ' about testing limits for real'}))
      `;
    }

    const failClient = /** @type {import("openai").default} */ ({
      embeddings: { create: async () => { throw new Error("fail"); } },
    });

    const results = await findMemories(db, failClient, "mem-find-limit", "testing limits", { limit: 2, minSimilarity: 0 });
    assert.ok(results.length <= 2, `Expected at most 2 results, got ${results.length}`);
  });

  it("filters by minSimilarity", async () => {
    const mockClient = /** @type {import("openai").default} */ ({
      embeddings: { create: async () => ({ data: [{ embedding: fakeEmbedding(0) }] }) },
    });

    const results = await findMemories(db, mockClient, "mem-find-1", "test", { minSimilarity: 0.99 });
    // Only exact match (seed=0) should pass
    assert.ok(results.length <= 1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// listMemories
// ═══════════════════════════════════════════════════════════════════
describe("listMemories", () => {
  it("returns all memories for a chat ordered by created_at DESC", async () => {
    await store.createChat("mem-list-1");
    // Insert with staggered timestamps
    await db.sql`INSERT INTO memories (chat_id, content, search_text, created_at) VALUES ('mem-list-1', 'First memory', to_tsvector('english', 'First memory'), '2025-01-01 10:00:00')`;
    await db.sql`INSERT INTO memories (chat_id, content, search_text, created_at) VALUES ('mem-list-1', 'Second memory', to_tsvector('english', 'Second memory'), '2025-01-02 10:00:00')`;
    await db.sql`INSERT INTO memories (chat_id, content, search_text, created_at) VALUES ('mem-list-1', 'Third memory', to_tsvector('english', 'Third memory'), '2025-01-03 10:00:00')`;

    const results = await listMemories(db, "mem-list-1");
    assert.equal(results.length, 3);
    assert.equal(results[0].content, "Third memory"); // newest first
    assert.equal(results[2].content, "First memory"); // oldest last
  });

  it("returns empty array for chat with no memories", async () => {
    await store.createChat("mem-list-empty");
    const results = await listMemories(db, "mem-list-empty");
    assert.deepEqual(results, []);
  });

  it("does not return memories from other chats", async () => {
    await store.createChat("mem-list-a");
    await store.createChat("mem-list-b");
    await db.sql`INSERT INTO memories (chat_id, content, search_text) VALUES ('mem-list-a', 'Chat A memory', to_tsvector('english', 'Chat A memory'))`;

    const results = await listMemories(db, "mem-list-b");
    assert.deepEqual(results, []);
  });
});

// ═══════════════════════════════════════════════════════════════════
// deleteMemory
// ═══════════════════════════════════════════════════════════════════
describe("deleteMemory", () => {
  it("deletes a memory by id and chatId", async () => {
    await store.createChat("mem-del-1");
    const { rows: [{ id }] } = await db.sql`
      INSERT INTO memories (chat_id, content, search_text)
      VALUES ('mem-del-1', 'To be deleted', to_tsvector('english', 'To be deleted'))
      RETURNING id
    `;

    const deleted = await deleteMemory(db, "mem-del-1", id);
    assert.equal(deleted, true);

    const { rows } = await db.sql`SELECT * FROM memories WHERE id = ${id}`;
    assert.equal(rows.length, 0);
  });

  it("returns false when memory does not exist", async () => {
    await store.createChat("mem-del-2");
    const deleted = await deleteMemory(db, "mem-del-2", 99999);
    assert.equal(deleted, false);
  });

  it("does not delete memory belonging to a different chat", async () => {
    await store.createChat("mem-del-a");
    await store.createChat("mem-del-b");
    const { rows: [{ id }] } = await db.sql`
      INSERT INTO memories (chat_id, content, search_text)
      VALUES ('mem-del-a', 'Chat A only', to_tsvector('english', 'Chat A only'))
      RETURNING id
    `;

    const deleted = await deleteMemory(db, "mem-del-b", id);
    assert.equal(deleted, false);

    const { rows } = await db.sql`SELECT * FROM memories WHERE id = ${id}`;
    assert.equal(rows.length, 1, "Memory should still exist in chat A");
  });
});

// ═══════════════════════════════════════════════════════════════════
// formatMemoriesContext
// ═══════════════════════════════════════════════════════════════════
describe("formatMemoriesContext", () => {
  it("truncates very long content", () => {
    const longContent = "a".repeat(3000);
    /** @type {import("../memory.js").MemoryRow[]} */
    const memories = [{
      id: 1, chat_id: "test", content: longContent,
      embedding: null, search_text: null,
      created_at: new Date("2025-01-15T10:30:00Z"),
    }];
    const output = formatMemoriesContext(memories);
    assert.ok(output.length < 3000);
  });
});
