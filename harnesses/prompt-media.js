import { hasMediaPath, resolveMediaPath } from "../attachment-paths.js";
import { renderContentBlock } from "../message-formatting.js";
import {
  buildMediaInputContextMessages,
  enrichMediaInputBlocks,
  extractTopLevelText,
} from "../media-input-enrichment.js";

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
 * Collect canonical media paths from quoted content without duplicating the
 * quoted text that `renderContentBlock()` already produced.
 * @param {IncomingContentBlock[]} blocks
 * @param {string[]} mediaLines
 * @param {boolean} includeMediaReferences
 * @returns {void}
 */
function collectQuotedMediaLines(blocks, mediaLines, includeMediaReferences) {
  if (!includeMediaReferences) {
    return;
  }
  for (const block of blocks) {
    if (block.type === "quote") {
      collectQuotedMediaLines(block.content, mediaLines, includeMediaReferences);
      continue;
    }
    if ((block.type === "image" || block.type === "video" || block.type === "audio" || block.type === "file") && hasMediaPath(block)) {
      const mediaLine = renderPromptMediaReference(block);
      if (mediaLine) {
        mediaLines.push(mediaLine);
      }
    }
  }
}

/**
 * Collect plain-text content and canonical media paths from a content block list.
 * Text-first harnesses represent media as explicit file references in the
 * synthesized prompt rather than as multimodal inputs.
 * @param {Array<IncomingContentBlock | ToolContentBlock>} blocks
 * @param {string[]} textParts
 * @param {string[]} mediaLines
 * @param {boolean} includeMediaReferences
 * @returns {void}
 */
function collectTextHarnessPromptParts(blocks, textParts, mediaLines, includeMediaReferences) {
  for (const block of blocks) {
    if (block.type === "quote") {
      const renderedQuote = renderContentBlock(block);
      if (renderedQuote) {
        textParts.push(renderedQuote);
      }
      collectQuotedMediaLines(block.content, mediaLines, includeMediaReferences);
      continue;
    }

    if (block.type === "image" && hasMediaPath(block)) {
      if (includeMediaReferences) {
        const markdownImage = renderMarkdownImageReference(block);
        if (markdownImage) {
          textParts.push(markdownImage);
          continue;
        }
        const mediaLine = renderPromptMediaReference(block);
        if (mediaLine) {
          mediaLines.push(mediaLine);
        }
      } else if (block.alt) {
        const rendered = renderContentBlock(block);
        if (rendered) {
          textParts.push(rendered);
        }
      }
      continue;
    }

    if ((block.type === "video" || block.type === "audio" || block.type === "file") && hasMediaPath(block)) {
      if (includeMediaReferences) {
        const mediaLine = renderPromptMediaReference(block);
        if (mediaLine) {
          mediaLines.push(mediaLine);
        }
      } else if (block.type === "video" && block.alt) {
        const rendered = renderContentBlock(block);
        if (rendered) {
          textParts.push(rendered);
        }
      }
      continue;
    }

    const rendered = renderContentBlock(block);
    if (rendered) {
      textParts.push(rendered);
    }
  }
}

/**
 * Build the text prompt that a text-first harness should see for one user turn.
 * @param {Array<IncomingContentBlock | ToolContentBlock>} blocks
 * @param {{ includeMediaReferences?: boolean }} [options]
 * @returns {string}
 */
export function buildTextHarnessPromptFromBlocks(blocks, options = {}) {
  const includeMediaReferences = options.includeMediaReferences ?? true;
  /** @type {string[]} */
  const textParts = [];
  /** @type {string[]} */
  const mediaLines = [];
  collectTextHarnessPromptParts(blocks, textParts, mediaLines, includeMediaReferences);

  const sections = [];
  if (textParts.length > 0) {
    sections.push(textParts.join("\n"));
  }
  if (mediaLines.length > 0) {
    const heading = mediaLines.length === 1
      ? "Media file available in this request:"
      : "Media files available in this request:";
    sections.push(`${heading}\n${mediaLines.join("\n")}`);
  }
  return sections.join("\n\n");
}

/**
 * @typedef {{
 *   llmClient: LlmClient,
 *   mediaToTextModels?: { image?: string, audio?: string, video?: string, general?: string },
 *   db: ChatDb,
 *   contextMessages: ChatMessage[],
 *   currentText: string,
 * }} PromptMediaAugmentInput
 */

/**
 * Create an ephemeral prompt-ready view of arbitrary incoming content blocks
 * for text-first harnesses.
 * @param {IncomingContentBlock[]} blocks
 * @param {Pick<LlmConfig, "llmClient" | "mediaToTextModels">} llmConfig
 * @param {ChatDb} db
 * @param {{ contextMessages?: ChatMessage[], currentText?: string }} [options]
 * @returns {Promise<{ blocks: IncomingContentBlock[], changed: boolean }>}
 */
export async function augmentContentBlocksForTextHarness(blocks, llmConfig, db, options = {}) {
  return enrichMediaInputBlocks(blocks, {
    llmClient: llmConfig.llmClient,
    mediaToTextModels: llmConfig.mediaToTextModels,
    db,
    contextMessages: options.contextMessages ?? [],
    currentText: options.currentText ?? extractTopLevelText(blocks),
  });
}

/**
 * Create an ephemeral prompt-ready view of the latest user message for
 * text-first harnesses. Canonical media blocks are preserved; generated alt is
 * attached only in the derived message copy.
 * @param {Message[]} messages
 * @param {Pick<LlmConfig, "llmClient" | "mediaToTextModels">} llmConfig
 * @param {ChatDb} db
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
  const contextMessages = buildMediaInputContextMessages(messages, userIndex);
  const augmented = await augmentContentBlocksForTextHarness(message.content, llmConfig, db, {
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
