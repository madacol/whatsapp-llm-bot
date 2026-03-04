import crypto from "node:crypto";
import { getModelModalities } from "./models-cache.js";
import config from "./config.js";
import { convertMediaBlockToOpenAI, sendSimpleChatCompletion } from "./llm.js";

/**
 * Create the media_to_text_cache table (and rename from old name if needed).
 * @param {PGlite} db
 */
export async function ensureMediaToTextSchema(db) {
  await db.sql`ALTER TABLE IF EXISTS content_translations RENAME TO media_to_text_cache`;
  await db.sql`
    CREATE TABLE IF NOT EXISTS media_to_text_cache (
      content_hash VARCHAR(16) NOT NULL,
      model_id TEXT NOT NULL,
      translation TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (content_hash, model_id)
    )
  `;
}

/** @type {WeakSet<PGlite>} */
const initialized = new WeakSet();

/**
 * Lazy-init schema (once per db instance).
 * @param {PGlite} db
 */
async function init(db) {
  if (initialized.has(db)) return;
  await ensureMediaToTextSchema(db);
  initialized.add(db);
}

/** @type {Record<string, string>} */
const MEDIA_TO_TEXT_PROMPTS = {
  image:
    "Describe this image in detail. Include all visible text, numbers, data, and visual elements.",
  audio:
    "Transcribe and describe this audio content in detail.",
  video:
    "Describe this video content in detail. Include all visible text, actions, and visual elements.",
};

/** @type {Record<string, string>} */
const DESCRIPTION_LABELS = {
  image: "Image description",
  audio: "Audio description",
  video: "Video description",
};

/**
 * Hash content data for cache lookup.
 * @param {string} data
 * @returns {string} First 16 hex chars of SHA-256
 */
function hashContent(data) {
  return crypto.createHash("sha256").update(data).digest("hex").slice(0, 16);
}

/**
 * @typedef {import("./store.js").MessageRow} MessageRow
 */

/**
 * Check if a content block is unsupported by the target model.
 * @param {IncomingContentBlock} block
 * @param {string[]} supportedModalities
 * @returns {boolean}
 */
function isUnsupportedBlock(block, supportedModalities) {
  return block.type !== "text" && block.type !== "quote" && !supportedModalities.includes(block.type);
}

/**
 * Check if any user message contains content blocks of types unsupported by the target model.
 * @param {MessageRow[]} messages
 * @param {string[]} supportedModalities
 * @returns {boolean}
 */
function hasUnsupportedContent(messages, supportedModalities) {
  for (const msg of messages) {
    if (msg.message_data?.role !== "user") continue;
    for (const block of msg.message_data.content) {
      if (isUnsupportedBlock(block, supportedModalities)) return true;
    }
  }
  return false;
}

/**
 * @typedef {{ messages: MessageRow[], skippedTypes: Set<string> }} MediaToTextResult
 */

/**
 * Convert unsupported media blocks in message history to text descriptions.
 * Returns the original messages if no conversion is needed.
 *
 * @param {MessageRow[]} messages
 * @param {string} targetModelId
 * @param {{ image?: string, audio?: string, video?: string, general?: string }} mediaToTextModels
 * @param {LlmClient} llmClient
 * @param {PGlite} db
 * @returns {Promise<MediaToTextResult>}
 */
export async function convertUnsupportedMedia(
  messages,
  targetModelId,
  mediaToTextModels,
  llmClient,
  db,
) {
  const supportedModalities = await getModelModalities(targetModelId);

  // Fast path: if model supports all content types present, return as-is
  if (!hasUnsupportedContent(messages, supportedModalities)) {
    return { messages, skippedTypes: new Set() };
  }

  await init(db);

  // Clone messages that have unsupported blocks and translate in a single pass
  /** @type {MessageRow[]} */
  const result = [];
  /** @type {Set<string>} */
  const skippedTypes = new Set();

  for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
    const msg = messages[msgIdx];
    if (msg.message_data?.role !== "user" || !msg.message_data.content.some((b) => isUnsupportedBlock(b, supportedModalities))) {
      result.push(msg);
      continue;
    }

    // Deep-clone message so we can mutate content
    const cloned = {
      ...msg,
      message_data: {
        ...msg.message_data,
        content: [...msg.message_data.content],
      },
    };
    result.push(cloned);

    for (let i = 0; i < cloned.message_data.content.length; i++) {
      const block = cloned.message_data.content[i];
      if (!isUnsupportedBlock(block, supportedModalities)) continue;

      const contentType = /** @type {"image" | "audio" | "video"} */ (block.type);
      const toTextModelId =
        mediaToTextModels[contentType] || mediaToTextModels.general || config[`${contentType}_to_text_model`] || config.media_to_text_model || "";

      if (!toTextModelId) {
        // No media-to-text model configured
        cloned.message_data.content[i] = /** @type {TextContentBlock} */ ({
          type: "text",
          text: `[Unsupported ${contentType} content — no media-to-text model configured]`,
        });
        skippedTypes.add(contentType);
        continue;
      }

      const contentData = /** @type {{ data: string }} */ (block).data;
      const hash = hashContent(contentData);

      // Check cache
      const { rows } =
        await db.sql`SELECT translation FROM media_to_text_cache WHERE content_hash = ${hash} AND model_id = ${toTextModelId}`;

      /** @type {string} */
      let translation;

      if (rows.length > 0) {
        translation = /** @type {string} */ (rows[0].translation);
      } else {
        // Build conversation context from preceding messages
        /** @type {Array<{role: string, content: string}>} */
        const contextMessages = [];
        for (let j = 0; j < msgIdx; j++) {
          const prev = messages[j];
          if (!prev.message_data) continue;
          const role = prev.message_data.role;
          if (role === "user" || role === "assistant") {
            const text = prev.message_data.content
              .filter(/** @returns {b is TextContentBlock} */ (b) => b.type === "text")
              .map((b) => b.text)
              .join("\n");
            if (text) {
              contextMessages.push({ role, content: text });
            }
          }
        }

        // Collect text blocks from the current message for context
        const currentText = cloned.message_data.content
          .filter(/** @returns {b is TextContentBlock} */ (b) => b.type === "text")
          .map((b) => b.text)
          .join("\n");

        // Call media-to-text model with conversation context
        const prompt = MEDIA_TO_TEXT_PROMPTS[contentType] || `Describe this ${contentType} content in detail.`;

        /** @type {Array<Record<string, unknown>>} */
        const userContent = [];
        if (currentText) {
          userContent.push({ type: "text", text: `User's message: ${currentText}\n\n${prompt}` });
        } else {
          userContent.push({ type: "text", text: prompt });
        }
        userContent.push(...convertMediaBlockToOpenAI(block, contentData));

        const llmMessages = /** @type {unknown[]} */ ([
          ...contextMessages,
          { role: "user", content: userContent },
        ]);

        translation = await sendSimpleChatCompletion(llmClient, toTextModelId, llmMessages) || `[Failed to describe ${contentType}]`;

        // Cache the translation
        await db.sql`INSERT INTO media_to_text_cache (content_hash, model_id, translation)
          VALUES (${hash}, ${toTextModelId}, ${translation})
          ON CONFLICT (content_hash, model_id) DO NOTHING`;
      }

      const label = DESCRIPTION_LABELS[contentType] || `${contentType} description`;
      cloned.message_data.content[i] = /** @type {TextContentBlock} */ ({
        type: "text",
        text: `[${label}: ${translation}]`,
      });
    }
  }

  return { messages: result, skippedTypes };
}
