process.env.TESTING = "1";

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { initStore } from "../store.js";
import {
  extractTextFromMessage,
  extractExchangeText,
  generateEmbedding,
  storeExchangeEmbedding,
  findSimilarMessages,
  formatMemoryContext,
} from "../memory.js";

/** @type {PGlite} */
let db;
/** @type {Awaited<ReturnType<typeof initStore>>} */
let store;

before(async () => {
  db = new PGlite("memory://", { extensions: { vector } });
  store = await initStore(db);
});

// ═══════════════════════════════════════════════════════════════════
// extractTextFromMessage
// ═══════════════════════════════════════════════════════════════════
describe("extractTextFromMessage", () => {
  it("extracts text from a user message", () => {
    /** @type {UserMessage} */
    const msg = { role: "user", content: [{ type: "text", text: "Hello world" }] };
    assert.equal(extractTextFromMessage(msg), "Hello world");
  });

  it("extracts text from an assistant message", () => {
    /** @type {AssistantMessage} */
    const msg = {
      role: "assistant",
      content: [{ type: "text", text: "I can help with that." }],
    };
    assert.equal(extractTextFromMessage(msg), "I can help with that.");
  });

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

  it("returns empty string for media-only content", () => {
    /** @type {UserMessage} */
    const msg = {
      role: "user",
      content: [{ type: "image", encoding: "base64", mime_type: "image/png", data: "abc123" }],
    };
    assert.equal(extractTextFromMessage(msg), "");
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

  it("concatenates multiple text blocks", () => {
    /** @type {UserMessage} */
    const msg = {
      role: "user",
      content: [
        { type: "text", text: "first part" },
        { type: "text", text: "second part" },
      ],
    };
    const text = extractTextFromMessage(msg);
    assert.ok(text.includes("first part"));
    assert.ok(text.includes("second part"));
  });
});

// ═══════════════════════════════════════════════════════════════════
// extractExchangeText
// ═══════════════════════════════════════════════════════════════════
describe("extractExchangeText", () => {
  it("formats a simple user+assistant exchange", () => {
    /** @type {Message[]} */
    const messages = [
      { role: "user", content: [{ type: "text", text: "What is Node.js?" }] },
      { role: "assistant", content: [{ type: "text", text: "Node.js is a JavaScript runtime." }] },
    ];
    const text = extractExchangeText(messages);
    assert.ok(text.includes("user: What is Node.js?"));
    assert.ok(text.includes("assistant: Node.js is a JavaScript runtime."));
  });

  it("includes tool calls and tool results", () => {
    /** @type {Message[]} */
    const messages = [
      { role: "user", content: [{ type: "text", text: "Search for cats" }] },
      { role: "assistant", content: [
        { type: "text", text: "Let me search." },
        { type: "tool", tool_id: "c1", name: "web_search", arguments: '{"query":"cats"}' },
      ]},
      { role: "tool", tool_id: "c1", content: [{ type: "text", text: "Found 3 results about cats" }] },
      { role: "assistant", content: [{ type: "text", text: "Here are the results." }] },
    ];
    const text = extractExchangeText(messages);
    assert.ok(text.includes("user: Search for cats"));
    assert.ok(text.includes("[tool: web_search("));
    assert.ok(text.includes("tool: Found 3 results about cats"));
    assert.ok(text.includes("assistant: Here are the results."));
  });

  it("skips binary content blocks", () => {
    /** @type {Message[]} */
    const messages = [
      { role: "user", content: [
        { type: "image", encoding: "base64", mime_type: "image/png", data: "abc" },
        { type: "text", text: "What is this?" },
      ]},
      { role: "assistant", content: [{ type: "text", text: "It's a cat." }] },
    ];
    const text = extractExchangeText(messages);
    assert.ok(!text.includes("abc"), "Should not include binary data");
    assert.ok(text.includes("What is this?"));
    assert.ok(text.includes("It's a cat."));
  });

  it("returns empty string for empty messages array", () => {
    assert.equal(extractExchangeText([]), "");
  });

  it("handles messages with only binary content", () => {
    /** @type {Message[]} */
    const messages = [
      { role: "user", content: [{ type: "image", encoding: "base64", mime_type: "image/png", data: "abc" }] },
    ];
    const text = extractExchangeText(messages);
    // Should still have a line for the user role, but content may be empty
    // The key thing is it doesn't crash
    assert.equal(typeof text, "string");
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
// storeExchangeEmbedding
// ═══════════════════════════════════════════════════════════════════
describe("storeExchangeEmbedding", () => {
  it("stores embedding, search_text, and exchange_text for a message", async () => {
    await store.createChat("mem-embed-1");
    /** @type {UserMessage} */
    const msg = { role: "user", content: [{ type: "text", text: "What is machine learning?" }] };
    const stored = await store.addMessage("mem-embed-1", msg, ["sender-1"]);

    const exchangeText = "user: What is machine learning?\nassistant: It's a field of AI.";
    const mockEmbedding = Array.from({ length: 3 }, (_, i) => i * 0.1);
    const mockClient = /** @type {import("openai").default} */ ({
      embeddings: {
        create: async () => ({ data: [{ embedding: mockEmbedding }] }),
      },
    });

    await storeExchangeEmbedding(db, mockClient, stored.message_id, exchangeText);

    const { rows: [row] } = await db.sql`
      SELECT embedding, search_text, exchange_text
      FROM messages WHERE message_id = ${stored.message_id}
    `;
    assert.ok(row.embedding, "embedding should be set");
    assert.ok(row.search_text, "search_text should be set");
    assert.equal(row.exchange_text, exchangeText, "exchange_text should be stored");
  });

  it("stores search_text and exchange_text even when embedding fails", async () => {
    await store.createChat("mem-embed-2");
    /** @type {UserMessage} */
    const msg = { role: "user", content: [{ type: "text", text: "Another test message for searching" }] };
    const stored = await store.addMessage("mem-embed-2", msg, ["sender-1"]);

    const exchangeText = "user: Another test message for searching";
    const mockClient = /** @type {import("openai").default} */ ({
      embeddings: { create: async () => { throw new Error("API error"); } },
    });

    await storeExchangeEmbedding(db, mockClient, stored.message_id, exchangeText);

    const { rows: [row] } = await db.sql`
      SELECT embedding, search_text, exchange_text
      FROM messages WHERE message_id = ${stored.message_id}
    `;
    assert.equal(row.embedding, null, "embedding should be null on failure");
    assert.ok(row.search_text, "search_text should still be set");
    assert.equal(row.exchange_text, exchangeText, "exchange_text should still be stored");
  });

  it("does not throw for empty exchange text", async () => {
    await store.createChat("mem-embed-3");
    /** @type {UserMessage} */
    const msg = {
      role: "user",
      content: [{ type: "image", encoding: "base64", mime_type: "image/png", data: "abc" }],
    };
    const stored = await store.addMessage("mem-embed-3", msg, ["sender-1"]);

    const mockClient = /** @type {import("openai").default} */ ({
      embeddings: { create: async () => { throw new Error("should not call"); } },
    });

    // Should not throw
    await storeExchangeEmbedding(db, mockClient, stored.message_id, "");
  });
});

// ═══════════════════════════════════════════════════════════════════
// findSimilarMessages
// ═══════════════════════════════════════════════════════════════════
describe("findSimilarMessages", () => {
  /** @type {import("openai").default} */
  let mockClient;

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
    // Normalize
    const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    return vec.map(v => v / mag);
  }

  before(async () => {
    const chatId = "mem-search-1";
    await store.createChat(chatId);

    // Insert several messages with known embeddings
    const messages = [
      "I love programming in JavaScript",
      "The weather is nice today",
      "Machine learning is fascinating",
      "Let's go hiking in the mountains",
      "Python is also a great language",
    ];

    for (let i = 0; i < messages.length; i++) {
      /** @type {UserMessage} */
      const msg = { role: "user", content: [{ type: "text", text: messages[i] }] };
      const stored = await store.addMessage(chatId, msg, ["sender-1"]);
      const emb = fakeEmbedding(i);
      await db.sql`
        UPDATE messages
        SET embedding = ${JSON.stringify(emb)}::vector,
            search_text = to_tsvector('english', ${messages[i]})
        WHERE message_id = ${stored.message_id}
      `;
    }

    // The mock client returns a vector similar to seed=0 (the JavaScript message)
    const queryEmb = fakeEmbedding(0);
    mockClient = /** @type {import("openai").default} */ ({
      embeddings: {
        create: async () => ({ data: [{ embedding: queryEmb }] }),
      },
    });
  });

  it("returns similar messages sorted by similarity", async () => {
    const results = await findSimilarMessages(db, mockClient, "mem-search-1", "JavaScript programming", {
      limit: 3,
      excludeRecent: 0,
      minSimilarity: 0,
    });

    assert.ok(results.length > 0, "Should find at least one similar message");
    assert.ok(results.length <= 3, "Should respect limit");
    // First result should be the most similar
    if (results.length > 1) {
      assert.ok(results[0].similarity >= results[1].similarity, "Results should be sorted by similarity");
    }
  });

  it("scopes search to the specified chatId", async () => {
    // Create a different chat with different messages
    await store.createChat("mem-search-other");
    /** @type {UserMessage} */
    const msg = { role: "user", content: [{ type: "text", text: "Other chat message" }] };
    const stored = await store.addMessage("mem-search-other", msg, ["sender-1"]);
    const emb = fakeEmbedding(0);
    await db.sql`
      UPDATE messages SET embedding = ${JSON.stringify(emb)}::vector
      WHERE message_id = ${stored.message_id}
    `;

    const results = await findSimilarMessages(db, mockClient, "mem-search-1", "test query", {
      excludeRecent: 0,
      minSimilarity: 0,
    });

    // None of the results should be from the other chat
    for (const r of results) {
      assert.equal(r.chat_id, "mem-search-1", "Results should only be from the queried chat");
    }
  });

  it("excludes recent messages via excludeRecent option", async () => {
    const results = await findSimilarMessages(db, mockClient, "mem-search-1", "test query", {
      excludeRecent: 5,
      minSimilarity: 0,
    });

    // All 5 messages should be excluded (as "recent")
    assert.equal(results.length, 0, "Should exclude all recent messages");
  });

  it("falls back to full-text search when embedding fails", async () => {
    const failClient = /** @type {import("openai").default} */ ({
      embeddings: { create: async () => { throw new Error("API error"); } },
    });

    const results = await findSimilarMessages(db, failClient, "mem-search-1", "JavaScript", {
      excludeRecent: 0,
      minSimilarity: 0,
    });

    assert.ok(results.length > 0, "Should fall back to full-text search");
    // Check that JavaScript-related message is found
    const texts = results.map(r => extractTextFromMessage(r.message_data));
    assert.ok(
      texts.some(t => t.toLowerCase().includes("javascript")),
      `Should find JavaScript message via full-text search, got: ${texts}`,
    );
  });

  it("filters by minSimilarity threshold", async () => {
    const results = await findSimilarMessages(db, mockClient, "mem-search-1", "test query", {
      excludeRecent: 0,
      minSimilarity: 0.99,
    });

    // Only the exact match (seed=0) should pass a 0.99 threshold
    assert.ok(results.length <= 1, "Very high threshold should filter most results");
  });
});

// ═══════════════════════════════════════════════════════════════════
// formatMemoryContext
// ═══════════════════════════════════════════════════════════════════
describe("formatMemoryContext", () => {
  it("uses exchange_text when available", () => {
    const results = [
      {
        message_id: 1,
        chat_id: "test",
        sender_id: "user1",
        message_data: /** @type {UserMessage} */ ({
          role: "user",
          content: [{ type: "text", text: "What is Node.js?" }],
        }),
        exchange_text: "user: What is Node.js?\nassistant: Node.js is a JavaScript runtime.",
        timestamp: new Date("2025-01-15T10:30:00Z"),
        similarity: 0.85,
      },
    ];

    const output = formatMemoryContext(results);
    assert.ok(output.includes("user: What is Node.js?"), "Should use exchange_text content");
    assert.ok(output.includes("assistant: Node.js is a JavaScript runtime."), "Should include full exchange");
  });

  it("falls back to extractTextFromMessage when exchange_text is null", () => {
    const results = [
      {
        message_id: 1,
        chat_id: "test",
        sender_id: "user1",
        message_data: /** @type {UserMessage} */ ({
          role: "user",
          content: [{ type: "text", text: "What is Node.js?" }],
        }),
        exchange_text: null,
        timestamp: new Date("2025-01-15T10:30:00Z"),
        similarity: 0.85,
      },
    ];

    const output = formatMemoryContext(results);
    assert.ok(output.includes("What is Node.js?"), "Should fall back to message text");
  });

  it("separates results with ---", () => {
    const results = [
      {
        message_id: 1,
        chat_id: "test",
        sender_id: "user1",
        message_data: /** @type {UserMessage} */ ({
          role: "user",
          content: [{ type: "text", text: "First question" }],
        }),
        exchange_text: "user: First question\nassistant: First answer",
        timestamp: new Date("2025-01-15T10:30:00Z"),
        similarity: 0.85,
      },
      {
        message_id: 2,
        chat_id: "test",
        sender_id: "user1",
        message_data: /** @type {UserMessage} */ ({
          role: "user",
          content: [{ type: "text", text: "Second question" }],
        }),
        exchange_text: "user: Second question\nassistant: Second answer",
        timestamp: new Date("2025-01-15T10:30:05Z"),
        similarity: 0.82,
      },
    ];

    const output = formatMemoryContext(results);
    assert.ok(output.includes("---"), "Should separate results with ---");
  });

  it("returns empty string for empty results", () => {
    assert.equal(formatMemoryContext([]), "");
  });

  it("truncates very long exchange text", () => {
    const longText = "a".repeat(3000);
    const results = [
      {
        message_id: 1,
        chat_id: "test",
        sender_id: "user1",
        message_data: /** @type {UserMessage} */ ({
          role: "user",
          content: [{ type: "text", text: longText }],
        }),
        exchange_text: longText,
        timestamp: new Date("2025-01-15T10:30:00Z"),
        similarity: 0.85,
      },
    ];

    const output = formatMemoryContext(results);
    assert.ok(output.length < longText.length, "Should truncate long exchange text");
  });
});
