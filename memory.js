import config from "./config.js";
import { resolveModel } from "./model-roles.js";
import { createLogger } from "./logger.js";

const log = createLogger("memory");

/**
 * Extract plain text from a Message JSONB object.
 * @param {Message} messageData
 * @returns {string}
 */
export function extractTextFromMessage(messageData) {
  /** @type {string[]} */
  const parts = [];

  for (const block of messageData.content) {
    switch (block.type) {
      case "text":
        parts.push(block.text);
        break;
      case "tool":
        parts.push(`[tool: ${block.name}(${block.arguments})]`);
        break;
      case "quote":
        for (const inner of block.content) {
          if (inner.type === "text") {
            parts.push(inner.text);
          }
        }
        break;
      // image, audio, video — skip binary data
    }
  }

  return parts.join("\n");
}

/**
 * Generate an embedding vector for the given text.
 * @param {import("openai").default} llmClient
 * @param {string} text
 * @returns {Promise<number[] | null>}
 */
export async function generateEmbedding(llmClient, text) {
  if (text.length < 10) return null;

  try {
    const response = await llmClient.embeddings.create({
      model: resolveModel("embedding"),
      input: text,
    });
    return response.data[0].embedding;
  } catch (err) {
    log.error("Embedding generation failed:", err);
    return null;
  }
}

/**
 * @typedef {{
 *   id: number;
 *   chat_id: string;
 *   content: string;
 *   embedding: string | null;
 *   search_text: string | null;
 *   created_at: Date;
 * }} MemoryRow
 */

/**
 * Save a free-text memory note for a chat.
 * Generates an embedding if possible, always stores search_text for FTS fallback.
 * @param {PGlite} db
 * @param {import("openai").default} llmClient
 * @param {string} chatId
 * @param {string} content
 * @returns {Promise<number>} The inserted memory id
 */
export async function saveMemory(db, llmClient, chatId, content) {
  const embedding = await generateEmbedding(llmClient, content);

  if (embedding) {
    const { rows: [row] } = await db.sql`
      INSERT INTO memories (chat_id, content, embedding, search_text)
      VALUES (${chatId}, ${content}, ${JSON.stringify(embedding)}::vector, to_tsvector('english', ${content}))
      RETURNING id
    `;
    return /** @type {number} */ (row.id);
  }

  const { rows: [row] } = await db.sql`
    INSERT INTO memories (chat_id, content, search_text)
    VALUES (${chatId}, ${content}, to_tsvector('english', ${content}))
    RETURNING id
  `;
  return /** @type {number} */ (row.id);
}

/**
 * @typedef {{
 *   limit?: number;
 *   minSimilarity?: number;
 * }} FindMemoriesOptions
 */

/**
 * Find memories relevant to a query using embedding similarity, falling back to FTS.
 * @param {PGlite} db
 * @param {import("openai").default} llmClient
 * @param {string} chatId
 * @param {string} queryText
 * @param {FindMemoriesOptions} [options]
 * @returns {Promise<(MemoryRow & { similarity: number })[]>}
 */
export async function findMemories(db, llmClient, chatId, queryText, options = {}) {
  const { limit = 5, minSimilarity = 0.3 } = options;
  const queryEmbedding = await generateEmbedding(llmClient, queryText);

  if (queryEmbedding) {
    const embeddingStr = JSON.stringify(queryEmbedding);
    const { rows } = await db.sql`
      SELECT id, chat_id, content, embedding, search_text, created_at,
        1 - (embedding <=> ${embeddingStr}::vector) AS similarity
      FROM memories
      WHERE chat_id = ${chatId} AND embedding IS NOT NULL
      ORDER BY embedding <=> ${embeddingStr}::vector
      LIMIT ${limit}
    `;
    return /** @type {(MemoryRow & { similarity: number })[]} */ (
      rows.filter(r => Number(r.similarity) >= minSimilarity)
    );
  }

  // FTS fallback
  const words = queryText.split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0) return [];
  const tsquery = words.map(w => w.replace(/[^a-zA-Z0-9]/g, "")).filter(Boolean).join(" | ");
  if (!tsquery) return [];

  const { rows } = await db.sql`
    SELECT id, chat_id, content, embedding, search_text, created_at,
      ts_rank(search_text, to_tsquery('english', ${tsquery})) AS similarity
    FROM memories
    WHERE chat_id = ${chatId} AND search_text IS NOT NULL
      AND search_text @@ to_tsquery('english', ${tsquery})
    ORDER BY ts_rank(search_text, to_tsquery('english', ${tsquery})) DESC
    LIMIT ${limit}
  `;
  return /** @type {(MemoryRow & { similarity: number })[]} */ (rows);
}

/**
 * List all memories for a chat, newest first.
 * @param {PGlite} db
 * @param {string} chatId
 * @returns {Promise<MemoryRow[]>}
 */
export async function listMemories(db, chatId) {
  const { rows } = await db.sql`
    SELECT id, chat_id, content, embedding, search_text, created_at
    FROM memories WHERE chat_id = ${chatId}
    ORDER BY created_at DESC
  `;
  return /** @type {MemoryRow[]} */ (rows);
}

/**
 * Delete a specific memory by id, scoped to chat.
 * @param {PGlite} db
 * @param {string} chatId
 * @param {number} memoryId
 * @returns {Promise<boolean>} true if a row was deleted
 */
export async function deleteMemory(db, chatId, memoryId) {
  const { rows } = await db.sql`
    DELETE FROM memories WHERE id = ${memoryId} AND chat_id = ${chatId}
    RETURNING id
  `;
  return rows.length > 0;
}

const MAX_MEMORY_LENGTH = 2000;

/**
 * Format memory rows into a readable string for system prompt injection.
 * @param {MemoryRow[]} memories
 * @returns {string}
 */
export function formatMemoriesContext(memories) {
  if (memories.length === 0) return "";

  return memories.map(m => {
    const truncated = m.content.length > MAX_MEMORY_LENGTH
      ? m.content.slice(0, MAX_MEMORY_LENGTH) + "\u2026"
      : m.content;
    const time = m.created_at instanceof Date
      ? m.created_at.toISOString().slice(0, 16).replace("T", " ")
      : String(m.created_at).slice(0, 16);
    return `[${time}] ${truncated}`;
  }).join("\n---\n");
}
