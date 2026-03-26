import { getModelModalities } from "./models-cache.js";
import config from "./config.js";
import { sendSimpleChatCompletion } from "./llm.js";
import { hashMediaBlock } from "./media-store.js";
import { isMediaBlock } from "./message-formatting.js";

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
 * @typedef {import("./store.js").MessageRow} MessageRow
 */

/**
 * Check if a content block is unsupported by the target model.
 * @param {IncomingContentBlock} block
 * @param {string[]} supportedModalities
 * @returns {boolean}
 */
function isUnsupportedBlock(block, supportedModalities) {
  return isMediaBlock(block) && !supportedModalities.includes(block.type);
}

/**
 * Check if a content block (or any nested block inside a quote) is unsupported.
 * @param {IncomingContentBlock} block
 * @param {string[]} supportedModalities
 * @returns {boolean}
 */
function hasUnsupportedNestedBlock(block, supportedModalities) {
  if (isUnsupportedBlock(block, supportedModalities)) return true;
  if (block.type === "quote") {
    return block.content.some((b) => isUnsupportedBlock(b, supportedModalities));
  }
  return false;
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
      if (hasUnsupportedNestedBlock(block, supportedModalities)) return true;
    }
  }
  return false;
}

/**
 * @typedef {{ messages: MessageRow[], skippedTypes: Set<string> }} MediaToTextResult
 */

/**
 * Resolve the media-to-text model ID for a given content type.
 * @param {"image" | "audio" | "video"} contentType
 * @param {{ image?: string, audio?: string, video?: string, general?: string }} mediaToTextModels
 * @returns {string} Model ID, or empty string if none configured
 */
export function resolveMediaModel(contentType, mediaToTextModels) {
  return mediaToTextModels[contentType] || mediaToTextModels.general || config[`${contentType}_to_text_model`] || config.media_to_text_model || "";
}

/**
 * Generate cached descriptive text for a media block.
 * @param {{
 *   block: IncomingContentBlock,
 *   contentType: "image" | "audio" | "video",
 *   modelId: string,
 *   llmClient: LlmClient,
 *   db: PGlite,
 *   contextMessages: ChatMessage[],
 *   currentText: string,
 * }} input
 * @returns {Promise<string>}
 */
export async function getMediaTranslation({
  block,
  contentType,
  modelId,
  llmClient,
  db,
  contextMessages,
  currentText,
}) {
  await init(db);
  const hash = (await hashMediaBlock(/** @type {ImageContentBlock | AudioContentBlock | VideoContentBlock} */ (block))).slice(0, 16);

  // Check cache
  const { rows } =
    await db.sql`SELECT translation FROM media_to_text_cache WHERE content_hash = ${hash} AND model_id = ${modelId}`;

  /** @type {string} */
  let translation;

  if (rows.length > 0) {
    translation = /** @type {string} */ (rows[0].translation);
  } else {
    const prompt = MEDIA_TO_TEXT_PROMPTS[contentType] || `Describe this ${contentType} content in detail.`;

    /** @type {IncomingContentBlock[]} */
    const userContent = [];
    if (currentText) {
      userContent.push({ type: "text", text: `User's message: ${currentText}\n\n${prompt}` });
    } else {
      userContent.push({ type: "text", text: prompt });
    }
    userContent.push(block);

    /** @type {ChatMessage[]} */
    const llmMessages = [
      ...contextMessages,
      { role: /** @type {const} */ ("user"), content: userContent },
    ];

    translation = await sendSimpleChatCompletion(llmClient, modelId, llmMessages) || `[Failed to describe ${contentType}]`;

    // Cache the translation
    await db.sql`INSERT INTO media_to_text_cache (content_hash, model_id, translation)
      VALUES (${hash}, ${modelId}, ${translation})
      ON CONFLICT (content_hash, model_id) DO NOTHING`;
  }

  return translation;
}

/**
 * Translate a single unsupported media block to a labeled text description.
 *
 * @param {IncomingContentBlock} block - The media block to convert
 * @param {"image" | "audio" | "video"} contentType
 * @param {string} modelId - The media-to-text model to use
 * @param {LlmClient} llmClient
 * @param {PGlite} db
 * @param {ChatMessage[]} contextMessages - Preceding conversation for richer prompts
 * @param {string} currentText - Text from the current message for context
 * @returns {Promise<TextContentBlock>}
 */
async function translateMediaBlock(block, contentType, modelId, llmClient, db, contextMessages, currentText) {
  const translation = await getMediaTranslation({
    block,
    contentType,
    modelId,
    llmClient,
    db,
    contextMessages,
    currentText,
  });
  const label = DESCRIPTION_LABELS[contentType] || `${contentType} description`;
  return /** @type {TextContentBlock} */ ({
    type: "text",
    text: `[${label}: ${translation}]`,
  });
}

/**
 * Build conversation context from preceding messages (text-only summary).
 * @param {MessageRow[]} messages
 * @param {number} upToIndex - Exclusive upper bound (messages before this index)
 * @returns {ChatMessage[]}
 */
function buildContextMessages(messages, upToIndex) {
  /** @type {ChatMessage[]} */
  const contextMessages = [];
  for (let j = 0; j < upToIndex; j++) {
    const prev = messages[j];
    if (!prev.message_data) continue;
    const role = prev.message_data.role;
    if (role === "user" || role === "assistant") {
      const text = prev.message_data.content
        .filter(/** @returns {b is TextContentBlock} */ (b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      if (text) {
        contextMessages.push({ role, content: [{ type: "text", text }] });
      }
    }
  }
  return contextMessages;
}

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
    if (msg.message_data?.role !== "user" || !msg.message_data.content.some((b) => hasUnsupportedNestedBlock(b, supportedModalities))) {
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

    // Build context once per message (not per block)
    const contextMessages = buildContextMessages(messages, msgIdx);
    const currentText = cloned.message_data.content
      .filter(/** @returns {b is TextContentBlock} */ (b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    for (let i = 0; i < cloned.message_data.content.length; i++) {
      const block = cloned.message_data.content[i];

      // Recurse into quote blocks to convert nested media
      if (block.type === "quote") {
        const quoteBlock = /** @type {QuoteContentBlock} */ (block);
        const clonedQuote = { ...quoteBlock, content: [...quoteBlock.content] };
        cloned.message_data.content[i] = clonedQuote;
        for (let qi = 0; qi < clonedQuote.content.length; qi++) {
          const qb = clonedQuote.content[qi];
          if (!isUnsupportedBlock(qb, supportedModalities)) continue;
          const mediaType = /** @type {"image" | "audio" | "video"} */ (qb.type);
          const modelId = resolveMediaModel(mediaType, mediaToTextModels);
          if (!modelId) {
            clonedQuote.content[qi] = /** @type {TextContentBlock} */ ({
              type: "text",
              text: `[Unsupported ${mediaType} content — no media-to-text model configured]`,
            });
            skippedTypes.add(mediaType);
            continue;
          }
          clonedQuote.content[qi] = await translateMediaBlock(qb, mediaType, modelId, llmClient, db, contextMessages, currentText);
        }
        continue;
      }

      if (!isUnsupportedBlock(block, supportedModalities)) continue;

      const contentType = /** @type {"image" | "audio" | "video"} */ (block.type);
      const modelId = resolveMediaModel(contentType, mediaToTextModels);

      if (!modelId) {
        cloned.message_data.content[i] = /** @type {TextContentBlock} */ ({
          type: "text",
          text: `[Unsupported ${contentType} content — no media-to-text model configured]`,
        });
        skippedTypes.add(contentType);
        continue;
      }

      cloned.message_data.content[i] = await translateMediaBlock(block, contentType, modelId, llmClient, db, contextMessages, currentText);
    }
  }

  return { messages: result, skippedTypes };
}
