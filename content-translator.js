import crypto from "node:crypto";
import { getModelModalities } from "./models-cache.js";
import config from "./config.js";

/**
 * Create the content_translations cache table.
 * @param {PGlite} db
 */
export async function ensureTranslationSchema(db) {
  await db.sql`
    CREATE TABLE IF NOT EXISTS content_translations (
      content_hash VARCHAR(16) NOT NULL,
      model_id TEXT NOT NULL,
      translation TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (content_hash, model_id)
    )
  `;
}

/** @type {Record<string, string>} */
const TRANSLATION_PROMPTS = {
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
 * Check if any user message contains content blocks of types unsupported by the target model.
 * @param {MessageRow[]} messages
 * @param {string[]} supportedModalities
 * @returns {boolean}
 */
function hasUnsupportedContent(messages, supportedModalities) {
  for (const msg of messages) {
    if (msg.message_data?.role !== "user") continue;
    for (const block of msg.message_data.content) {
      if (block.type !== "text" && block.type !== "quote" && !supportedModalities.includes(block.type)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Translate unsupported content blocks in message history to text descriptions.
 * Returns the original messages if no translation is needed.
 *
 * @param {MessageRow[]} messages
 * @param {string} targetModelId
 * @param {{ image?: string, audio?: string, video?: string }} contentModels
 * @param {import("openai").default} llmClient
 * @param {PGlite} db
 * @returns {Promise<MessageRow[]>}
 */
export async function translateUnsupportedContent(
  messages,
  targetModelId,
  contentModels,
  llmClient,
  db,
) {
  const supportedModalities = await getModelModalities(targetModelId);

  // Fast path: if model supports all content types present, return as-is
  if (!hasUnsupportedContent(messages, supportedModalities)) {
    return messages;
  }

  // Deep-clone only messages that need translation
  /** @type {MessageRow[]} */
  const result = messages.map((msg) => {
    if (msg.message_data?.role !== "user") return msg;

    const hasUnsupported = msg.message_data.content.some(
      (block) =>
        block.type !== "text" &&
        block.type !== "quote" &&
        !supportedModalities.includes(block.type),
    );

    if (!hasUnsupported) return msg;

    return {
      ...msg,
      message_data: {
        ...msg.message_data,
        content: [...msg.message_data.content],
      },
    };
  });

  // Translate unsupported blocks
  for (const msg of result) {
    if (msg.message_data?.role !== "user") continue;

    for (let i = 0; i < msg.message_data.content.length; i++) {
      const block = msg.message_data.content[i];
      if (
        block.type === "text" ||
        block.type === "quote" ||
        supportedModalities.includes(block.type)
      ) {
        continue;
      }

      const contentType = /** @type {"image" | "audio" | "video"} */ (block.type);
      const translationModelId =
        contentModels[contentType] || config.content_model || "";

      if (!translationModelId) {
        // No translation model configured — replace with placeholder
        msg.message_data.content[i] = /** @type {TextContentBlock} */ ({
          type: "text",
          text: `[Unsupported ${contentType} content — no translation model configured]`,
        });
        continue;
      }

      // Hash the content data for cache lookup
      const contentData = /** @type {{ data: string }} */ (block).data;
      const hash = hashContent(contentData);

      // Check cache
      const { rows } =
        await db.sql`SELECT translation FROM content_translations WHERE content_hash = ${hash} AND model_id = ${translationModelId}`;

      /** @type {string} */
      let translation;

      if (rows.length > 0) {
        translation = /** @type {string} */ (rows[0].translation);
      } else {
        // Call translation model
        const prompt = TRANSLATION_PROMPTS[contentType] || `Describe this ${contentType} content in detail.`;

        /** @type {import("openai").default.ChatCompletionMessageParam[]} */
        const llmMessages = [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              ...(contentType === "image"
                ? [
                    {
                      type: /** @type {const} */ ("image_url"),
                      image_url: {
                        url: `data:${/** @type {ImageContentBlock} */ (block).mime_type};base64,${contentData}`,
                      },
                    },
                  ]
                : contentType === "audio"
                  ? [
                      {
                        type: /** @type {const} */ ("input_audio"),
                        input_audio: {
                          data: contentData,
                          format: /** @type {const} */ ("mp3"),
                        },
                      },
                    ]
                  : []),
            ],
          },
        ];

        const response = await llmClient.chat.completions.create({
          model: translationModelId,
          messages: llmMessages,
        });

        translation = response.choices[0].message.content || `[Failed to describe ${contentType}]`;

        // Cache the translation
        await db.sql`INSERT INTO content_translations (content_hash, model_id, translation)
          VALUES (${hash}, ${translationModelId}, ${translation})
          ON CONFLICT (content_hash, model_id) DO NOTHING`;
      }

      const label = DESCRIPTION_LABELS[contentType] || `${contentType} description`;
      msg.message_data.content[i] = /** @type {TextContentBlock} */ ({
        type: "text",
        text: `[${label}: ${translation}]`,
      });
    }
  }

  return result;
}
