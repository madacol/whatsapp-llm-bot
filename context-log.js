/**
 * Debug tool: stores and cleans up LLM request context snapshots.
 */
import { createLogger } from "./logger.js";

const log = createLogger("context-log");

/**
 * Replace binary media data in internal Message[] with short hash stubs.
 * Works on a deep-cloned copy to avoid mutating the originals.
 * @param {Message[]} messages
 * @returns {unknown[]}
 */
export function sanitizeMessagesForLog(messages) {
  /** @type {unknown[]} */
  const clone = JSON.parse(JSON.stringify(messages));

  for (const msg of clone) {
    const m = /** @type {Record<string, unknown>} */ (msg);
    if (!Array.isArray(m.content)) continue;

    for (let i = 0; i < m.content.length; i++) {
      const part = /** @type {Record<string, unknown>} */ (m.content[i]);

      if (part.type === "image" || part.type === "video" || part.type === "audio") {
        const data = /** @type {string | undefined} */ (part.data);
        const hash = typeof data === "string" ? data.slice(-10, -4) : "??????";
        m.content[i] = { ...part, data: `[${part.type}:${hash}]` };
      }
    }
  }

  return clone;
}

/**
 * Store the full LLM request context on an assistant message row.
 * Also cleans up contexts older than 1 hour.
 *
 * Callers may fire-and-forget (no await), but internally the queries are
 * properly awaited so references to `messages` are released promptly
 * rather than being pinned by unresolved promise chains.
 * @param {PGlite} db
 * @param {number} messageId
 * @param {string} model
 * @param {string} systemPrompt
 * @param {Message[]} messages
 * @param {ToolDescriptor[]} tools
 */
export async function storeLlmContext(db, messageId, model, systemPrompt, messages, tools) {
  const llmContext = {
    model,
    system_prompt: systemPrompt,
    messages: sanitizeMessagesForLog(messages),
    tools: tools.map((tool) => tool.name),
  };
  try {
    await db.sql`UPDATE messages SET llm_context = ${JSON.stringify(llmContext)}
      WHERE message_id = ${messageId}`;
  } catch (err) {
    log.warn("Failed to store LLM context:", err);
  }
  try {
    await db.sql`UPDATE messages SET llm_context = NULL
      WHERE llm_context IS NOT NULL
      AND timestamp < NOW() - INTERVAL '1 hour'`;
  } catch (err) {
    log.warn("Failed to clean up old LLM contexts:", err);
  }
}
