import { hasMediaPath, resolveMediaPath } from "../attachment-paths.js";
import { getMediaTranslation, resolveMediaModel } from "../media-to-text.js";

/**
 * @param {string} value
 * @returns {string}
 */
function singleLine(value) {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * @param {string} text
 * @returns {string}
 */
function escapeMarkdownImageAlt(text) {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\]/g, "\\]")
    .replace(/\r?\n/g, " ")
    .trim();
}

/**
 * @param {ImageContentBlock} block
 * @returns {string | null}
 */
export function renderMarkdownImageReference(block) {
  if (!hasMediaPath(block) || !block.alt) {
    return null;
  }
  return `![${escapeMarkdownImageAlt(block.alt)}](${resolveMediaPath(block.path)})`;
}

/**
 * Render a text-first harness attachment reference. The canonical media path is
 * useful for bot-native tools, while the filesystem path is what coding agents
 * can actually read with their file tools.
 * @param {ImageContentBlock | VideoContentBlock | AudioContentBlock | FileContentBlock} block
 * @returns {string | null}
 */
export function renderPromptMediaReference(block) {
  if (!hasMediaPath(block)) {
    return null;
  }
  /** @type {string[]} */
  const metadata = [];
  if ("file_name" in block && typeof block.file_name === "string" && block.file_name.trim()) {
    metadata.push(`name: ${singleLine(block.file_name)}`);
  }
  if (typeof block.mime_type === "string" && block.mime_type.trim()) {
    metadata.push(`mime: ${singleLine(block.mime_type)}`);
  }
  const suffix = metadata.length > 0 ? ` (${metadata.join(", ")})` : "";
  return `- ${block.type}${suffix}: ${resolveMediaPath(block.path)} (canonical: ${block.path})`;
}

/**
 * @param {Array<IncomingContentBlock | ToolCallContentBlock>} blocks
 * @returns {string}
 */
function extractTopLevelText(blocks) {
  return blocks
    .filter(/** @returns {block is TextContentBlock} */ (block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/**
 * Build light text-only context for media-to-text requests.
 * @param {Message[]} messages
 * @param {number} upToIndex
 * @returns {ChatMessage[]}
 */
function buildPromptContextMessages(messages, upToIndex) {
  /** @type {ChatMessage[]} */
  const contextMessages = [];
  for (let i = 0; i < upToIndex; i++) {
    const message = messages[i];
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }
    const text = extractTopLevelText(message.content);
    if (!text) {
      continue;
    }
    contextMessages.push({ role: message.role, content: [{ type: "text", text }] });
  }
  return contextMessages;
}

/**
 * @typedef {{
 *   llmClient: LlmClient,
 *   mediaToTextModels?: { image?: string, audio?: string, video?: string, general?: string },
 *   db: PGlite,
 *   contextMessages: ChatMessage[],
 *   currentText: string,
 * }} PromptMediaAugmentInput
 */

/**
 * @param {IncomingContentBlock[]} blocks
 * @param {PromptMediaAugmentInput} input
 * @returns {Promise<{ blocks: IncomingContentBlock[], changed: boolean }>}
 */
async function augmentBlocks(blocks, input) {
  /** @type {IncomingContentBlock[]} */
  const augmented = [];
  let changed = false;

  for (const block of blocks) {
    if (block.type === "quote") {
      const nested = await augmentBlocks(block.content, input);
      augmented.push(nested.changed ? { ...block, content: nested.blocks } : block);
      changed ||= nested.changed;
      continue;
    }

    if (block.type === "image" || block.type === "video") {
      if (block.alt) {
        augmented.push(block);
        continue;
      }
      const modelId = resolveMediaModel(block.type, input.mediaToTextModels ?? {});
      if (!modelId) {
        augmented.push(block);
        continue;
      }
      try {
        const alt = await getMediaTranslation({
          block,
          contentType: block.type,
          modelId,
          llmClient: input.llmClient,
          db: input.db,
          contextMessages: input.contextMessages,
          currentText: input.currentText,
        });
        augmented.push({ ...block, alt });
        changed = true;
      } catch {
        augmented.push(block);
      }
      continue;
    }

    if (block.type === "audio") {
      augmented.push(block);
      const modelId = resolveMediaModel("audio", input.mediaToTextModels ?? {});
      if (!modelId) {
        continue;
      }
      try {
        const description = await getMediaTranslation({
          block,
          contentType: "audio",
          modelId,
          llmClient: input.llmClient,
          db: input.db,
          contextMessages: input.contextMessages,
          currentText: input.currentText,
        });
        augmented.push({ type: "text", text: `[Audio description: ${description}]` });
        changed = true;
      } catch {
        // Keep the canonical audio block when alt generation fails.
      }
      continue;
    }

    augmented.push(block);
  }

  return { blocks: augmented, changed };
}

/**
 * Create an ephemeral prompt-ready view of the latest user message for
 * text-first harnesses. Canonical media blocks are preserved; generated alt is
 * attached only in the derived message copy.
 * @param {Message[]} messages
 * @param {Pick<LlmConfig, "llmClient" | "mediaToTextModels">} llmConfig
 * @param {PGlite} db
 * @returns {Promise<Message[]>}
 */
export async function augmentLatestUserMessageForTextHarness(messages, llmConfig, db) {
  let userIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userIndex = i;
      break;
    }
  }
  if (userIndex === -1) {
    return messages;
  }

  const message = /** @type {UserMessage} */ (messages[userIndex]);
  const currentText = extractTopLevelText(message.content);
  const contextMessages = buildPromptContextMessages(messages, userIndex);
  const augmented = await augmentBlocks(message.content, {
    llmClient: llmConfig.llmClient,
    mediaToTextModels: llmConfig.mediaToTextModels,
    db,
    contextMessages,
    currentText,
  });

  if (!augmented.changed) {
    return messages;
  }

  const nextMessages = [...messages];
  nextMessages[userIndex] = { ...message, content: augmented.blocks };
  return nextMessages;
}
