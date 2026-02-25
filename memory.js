import config from "./config.js";

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
 * Build a single text representation of a full exchange (multiple messages).
 * Works on our own Message[] type from DB message_data JSONB.
 * @param {Message[]} messages
 * @returns {string}
 */
export function extractExchangeText(messages) {
  if (messages.length === 0) return "";

  return messages.map(msg => {
    const text = extractTextFromMessage(msg);
    if (!text) return null;
    return `${msg.role}: ${text}`;
  }).filter(Boolean).join("\n");
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
      model: config.embedding_model,
      input: text,
    });
    return response.data[0].embedding;
  } catch (err) {
    console.error("Embedding generation failed:", err);
    return null;
  }
}

/**
 * Store embedding, search_text, and exchange_text for a message. Non-fatal on failure.
 * @param {PGlite} db
 * @param {import("openai").default} llmClient
 * @param {number} messageId
 * @param {string} exchangeText
 */
export async function storeExchangeEmbedding(db, llmClient, messageId, exchangeText) {
  try {
    if (!exchangeText) return;

    const embedding = await generateEmbedding(llmClient, exchangeText);

    if (embedding) {
      await db.sql`
        UPDATE messages
        SET embedding = ${JSON.stringify(embedding)}::vector,
            search_text = to_tsvector('english', ${exchangeText}),
            exchange_text = ${exchangeText}
        WHERE message_id = ${messageId}
      `;
    } else {
      await db.sql`
        UPDATE messages
        SET search_text = to_tsvector('english', ${exchangeText}),
            exchange_text = ${exchangeText}
        WHERE message_id = ${messageId}
      `;
    }
  } catch (err) {
    console.error("storeExchangeEmbedding failed:", err);
  }
}

/**
 * Fire-and-forget wrapper: embed an exchange if memory is enabled.
 * @param {PGlite} db
 * @param {import("openai").default | undefined} llmClient
 * @param {number} messageId
 * @param {string} exchangeText
 * @param {boolean} [enabled]
 */
export function maybeEmbed(db, llmClient, messageId, exchangeText, enabled) {
  if (!enabled || !llmClient) return;
  storeExchangeEmbedding(db, llmClient, messageId, exchangeText)
    .catch(err => console.error("Embedding failed:", err));
}

/**
 * @typedef {{
 *   message_id: number;
 *   chat_id: string;
 *   sender_id: string;
 *   message_data: Message;
 *   exchange_text: string | null;
 *   timestamp: Date;
 *   similarity: number;
 * }} SimilarMessage
 */

/**
 * @typedef {{
 *   limit?: number;
 *   excludeRecent?: number;
 *   minSimilarity?: number;
 * }} FindSimilarOptions
 */

/**
 * Find messages similar to the query text in the given chat.
 * Falls back to full-text search if embedding generation fails.
 * @param {PGlite} db
 * @param {import("openai").default} llmClient
 * @param {string} chatId
 * @param {string} queryText
 * @param {FindSimilarOptions} [options]
 * @returns {Promise<SimilarMessage[]>}
 */
export async function findSimilarMessages(db, llmClient, chatId, queryText, options = {}) {
  const { limit = 5, excludeRecent = 50, minSimilarity = 0.3 } = options;

  const queryEmbedding = await generateEmbedding(llmClient, queryText);

  if (queryEmbedding) {
    const embeddingStr = JSON.stringify(queryEmbedding);
    const { rows } = await db.sql`
      SELECT message_id, chat_id, sender_id, message_data, exchange_text, timestamp,
        1 - (embedding <=> ${embeddingStr}::vector) AS similarity
      FROM messages
      WHERE chat_id = ${chatId} AND cleared_at IS NULL AND embedding IS NOT NULL
        AND message_id NOT IN (
          SELECT message_id FROM messages
          WHERE chat_id = ${chatId} AND cleared_at IS NULL
          ORDER BY timestamp DESC LIMIT ${excludeRecent}
        )
      ORDER BY embedding <=> ${embeddingStr}::vector
      LIMIT ${limit}
    `;

    return /** @type {SimilarMessage[]} */ (
      rows.filter(r => Number(r.similarity) >= minSimilarity)
    );
  }

  // Fallback: full-text search
  return fullTextSearch(db, chatId, queryText, limit, excludeRecent);
}

/**
 * Full-text search fallback using tsvector/tsquery.
 * @param {PGlite} db
 * @param {string} chatId
 * @param {string} queryText
 * @param {number} limit
 * @param {number} excludeRecent
 * @returns {Promise<SimilarMessage[]>}
 */
async function fullTextSearch(db, chatId, queryText, limit, excludeRecent) {
  // Convert query to tsquery — split words and join with &
  const words = queryText.split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0) return [];
  const tsquery = words.map(w => w.replace(/[^a-zA-Z0-9]/g, "")).filter(Boolean).join(" | ");
  if (!tsquery) return [];

  const { rows } = await db.sql`
    SELECT message_id, chat_id, sender_id, message_data, exchange_text, timestamp,
      ts_rank(search_text, to_tsquery('english', ${tsquery})) AS similarity
    FROM messages
    WHERE chat_id = ${chatId} AND cleared_at IS NULL AND search_text IS NOT NULL
      AND search_text @@ to_tsquery('english', ${tsquery})
      AND message_id NOT IN (
        SELECT message_id FROM messages
        WHERE chat_id = ${chatId} AND cleared_at IS NULL
        ORDER BY timestamp DESC LIMIT ${excludeRecent}
      )
    ORDER BY ts_rank(search_text, to_tsquery('english', ${tsquery})) DESC
    LIMIT ${limit}
  `;

  return /** @type {SimilarMessage[]} */ (rows);
}

const MAX_EXCHANGE_LENGTH = 2000;

/**
 * Format retrieved similar messages into a readable string for system prompt injection.
 * @param {SimilarMessage[]} results
 * @returns {string}
 */
export function formatMemoryContext(results) {
  if (results.length === 0) return "";

  return results.map(r => {
    const text = r.exchange_text || extractTextFromMessage(r.message_data);
    const truncated = text.length > MAX_EXCHANGE_LENGTH
      ? text.slice(0, MAX_EXCHANGE_LENGTH) + "…"
      : text;
    const time = r.timestamp instanceof Date
      ? r.timestamp.toISOString().slice(0, 16).replace("T", " ")
      : String(r.timestamp).slice(0, 16);
    return `[${time}]\n${truncated}`;
  }).join("\n---\n");
}
