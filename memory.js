import { resolveModel } from "./model-roles.js";
import { createEmbedding } from "./llm.js";
import { createLogger } from "./logger.js";

const log = createLogger("memory");

/**
 * Extract plain text from a Message object.
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
 * @param {LlmClient} llmClient
 * @param {string} text
 * @returns {Promise<number[] | null>}
 */
export async function generateEmbedding(llmClient, text) {
  if (text.length < 10) return null;

  try {
    return await createEmbedding(llmClient, resolveModel("embedding"), text);
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
 * @param {import("./sqlite-db.js").SqliteDb} db
 * @param {LlmClient} llmClient
 * @param {string} chatId
 * @param {string} content
 * @returns {Promise<number>} The inserted memory id
 */
export async function saveMemory(db, llmClient, chatId, content) {
  const embedding = await generateEmbedding(llmClient, content);

  const { rows: [row] } = await db.sql`
    INSERT INTO memories (chat_id, content, embedding, search_text)
    VALUES (${chatId}, ${content}, ${embedding ? JSON.stringify(embedding) : null}, ${content})
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
 * @param {import("./sqlite-db.js").SqliteDb} db
 * @param {LlmClient} llmClient
 * @param {string} chatId
 * @param {string} queryText
 * @param {FindMemoriesOptions} [options]
 * @returns {Promise<(MemoryRow & { similarity: number })[]>}
 */
export async function findMemories(db, llmClient, chatId, queryText, options = {}) {
  const { limit = 5, minSimilarity = 0.3 } = options;
  const queryEmbedding = await generateEmbedding(llmClient, queryText);

  if (queryEmbedding) {
    const { rows } = await db.sql`
      SELECT id, chat_id, content, embedding, search_text, created_at
      FROM memories
      WHERE chat_id = ${chatId} AND embedding IS NOT NULL
    `;
    return rows
      .map((row) => toMemorySimilarityRow(row, queryEmbedding))
      .filter(/** @returns {row is MemoryRow & { similarity: number }} */ (row) => row !== null && row.similarity >= minSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  return findMemoriesByText(db, chatId, queryText, limit);
}

/**
 * List all memories for a chat, newest first.
 * @param {import("./sqlite-db.js").SqliteDb} db
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
 * @param {import("./sqlite-db.js").SqliteDb} db
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
 * @param {Record<string, unknown>} row
 * @param {number[]} queryEmbedding
 * @returns {(MemoryRow & { similarity: number }) | null}
 */
function toMemorySimilarityRow(row, queryEmbedding) {
  if (typeof row.embedding !== "string") {
    return null;
  }
  const embedding = parseEmbedding(row.embedding);
  if (!embedding) {
    return null;
  }
  return /** @type {MemoryRow & { similarity: number }} */ ({
    ...row,
    similarity: cosineSimilarity(queryEmbedding, embedding),
  });
}

/**
 * @param {string} value
 * @returns {number[] | null}
 */
function parseEmbedding(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "number")
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/**
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
function cosineSimilarity(a, b) {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;
  let dot = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;
  for (let i = 0; i < length; i += 1) {
    dot += a[i] * b[i];
    magnitudeA += a[i] * a[i];
    magnitudeB += b[i] * b[i];
  }
  if (magnitudeA === 0 || magnitudeB === 0) return 0;
  return dot / (Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB));
}

/**
 * @param {import("./sqlite-db.js").SqliteDb} db
 * @param {string} chatId
 * @param {string} queryText
 * @param {number} limit
 * @returns {Promise<(MemoryRow & { similarity: number })[]>}
 */
async function findMemoriesByText(db, chatId, queryText, limit) {
  const words = queryText
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.replace(/[^a-z0-9]/g, ""))
    .filter((word) => word.length > 0);
  if (words.length === 0) return [];

  const { rows } = await db.sql`
    SELECT id, chat_id, content, embedding, search_text, created_at
    FROM memories
    WHERE chat_id = ${chatId} AND search_text IS NOT NULL
  `;

  return rows
    .map((row) => scoreMemoryTextRow(row, words))
    .filter(/** @returns {row is MemoryRow & { similarity: number }} */ (row) => row !== null && row.similarity > 0)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}

/**
 * @param {Record<string, unknown>} row
 * @param {string[]} words
 * @returns {(MemoryRow & { similarity: number }) | null}
 */
function scoreMemoryTextRow(row, words) {
  if (typeof row.content !== "string") {
    return null;
  }
  const content = row.content.toLowerCase();
  const matches = words.filter((word) => content.includes(word)).length;
  return /** @type {MemoryRow & { similarity: number }} */ ({
    ...row,
    similarity: matches / words.length,
  });
}

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
