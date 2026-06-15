import { hasMediaPath, resolveMediaPath } from "../attachment-paths.js";
import { renderContentBlock } from "../message-formatting.js";
import { getMediaTranslation, resolveMediaModel } from "../media-to-text.js";
import { createLogger } from "../logger.js";
import { errorToString } from "../utils.js";

const log = createLogger("conversation:live-input");

/**
 * @typedef {{
 *   block: AudioContentBlock,
 *   modelId: string,
 * }} LiveInputAudioTranscriptionStart
 */

/**
 * @typedef {{
 *   block: AudioContentBlock,
 *   modelId: string,
 *   transcription: string,
 * }} LiveInputAudioTranscriptionComplete
 */

/**
 * @typedef {{
 *   block: AudioContentBlock,
 *   modelId: string,
 *   error: unknown,
 * }} LiveInputAudioTranscriptionFailure
 */

/**
 * @typedef {{
 *   onAudioTranscriptionStart?: (event: LiveInputAudioTranscriptionStart) => void | Promise<void>,
 *   onAudioTranscriptionComplete?: (event: LiveInputAudioTranscriptionComplete) => void | Promise<void>,
 *   onAudioTranscriptionFailure?: (event: LiveInputAudioTranscriptionFailure) => void | Promise<void>,
 * }} LiveInputAudioTranscriptionObserver
 */

/**
 * @param {string} value
 * @returns {string}
 */
function singleLine(value) {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * @param {ImageContentBlock | VideoContentBlock | AudioContentBlock | FileContentBlock} block
 * @returns {string | null}
 */
function renderLiveInputMediaReference(block) {
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
 * @param {ImageContentBlock | VideoContentBlock | AudioContentBlock | FileContentBlock} block
 * @returns {string | null}
 */
function getMediaBlockPath(block) {
  return hasMediaPath(block) ? block.path : null;
}

/**
 * @param {IncomingContentBlock[]} blocks
 * @returns {string}
 */
function extractTopLevelText(blocks) {
  return blocks
    .filter(/** @returns {block is TextContentBlock} */ (block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/**
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
      const mediaLine = renderLiveInputMediaReference(block);
      if (mediaLine) {
        mediaLines.push(mediaLine);
      }
    }
  }
}

/**
 * @param {Array<IncomingContentBlock | ToolContentBlock>} blocks
 * @param {{ includeMediaReferences?: boolean }} [options]
 * @returns {string}
 */
function renderLiveInputPrompt(blocks, options = {}) {
  const includeMediaReferences = options.includeMediaReferences ?? true;
  /** @type {string[]} */
  const textParts = [];
  /** @type {string[]} */
  const mediaLines = [];

  for (const block of blocks) {
    if (block.type === "quote") {
      const renderedQuote = renderContentBlock(block);
      if (renderedQuote) {
        textParts.push(renderedQuote);
      }
      collectQuotedMediaLines(block.content, mediaLines, includeMediaReferences);
      continue;
    }

    if ((block.type === "image" || block.type === "video" || block.type === "audio" || block.type === "file") && hasMediaPath(block)) {
      if (includeMediaReferences) {
        const mediaLine = renderLiveInputMediaReference(block);
        if (mediaLine) {
          mediaLines.push(mediaLine);
        }
      }
      const hasDescription = (block.type === "image" || block.type === "video") && typeof block.alt === "string" && block.alt.trim().length > 0;
      if (!hasDescription) {
        continue;
      }
    }

    const rendered = renderContentBlock(block);
    if (rendered) {
      textParts.push(rendered);
    }
  }

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
 * @param {IncomingContentBlock[]} blocks
 * @param {{
 *   llmClient: LlmClient,
 *   mediaToTextModels?: { image?: string, audio?: string, video?: string, general?: string },
 *   db: ChatDb,
 *   contextMessages: ChatMessage[],
 *   currentText: string,
 * } & LiveInputAudioTranscriptionObserver} input
 * @returns {Promise<IncomingContentBlock[]>}
 */
async function augmentLiveInputBlocks(blocks, input) {
  /** @type {IncomingContentBlock[]} */
  const augmented = [];

  for (const block of blocks) {
    if (block.type === "quote") {
      augmented.push({ ...block, content: await augmentLiveInputBlocks(block.content, input) });
      continue;
    }

    if (block.type === "image" || block.type === "video") {
      if (block.alt) {
        augmented.push(block);
        continue;
      }
      const modelId = resolveMediaModel(block.type, input.mediaToTextModels ?? {});
      if (!modelId) {
        log.info("Skipped live input media transcription; no model configured", {
          contentType: block.type,
          path: getMediaBlockPath(block),
        });
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
        log.info("Added live input media description", {
          contentType: block.type,
          path: getMediaBlockPath(block),
          modelId,
          descriptionLength: alt.length,
        });
        augmented.push({ ...block, alt });
      } catch (error) {
        log.warn("Live input media transcription failed", {
          contentType: block.type,
          path: getMediaBlockPath(block),
          modelId,
          error: errorToString(error),
        });
        augmented.push(block);
      }
      continue;
    }

    if (block.type === "audio") {
      augmented.push(block);
      const modelId = resolveMediaModel("audio", input.mediaToTextModels ?? {});
      if (!modelId) {
        log.info("Skipped live input audio transcription; no model configured", {
          path: getMediaBlockPath(block),
        });
        continue;
      }
      try {
        await input.onAudioTranscriptionStart?.({ block, modelId });
        const description = await getMediaTranslation({
          block,
          contentType: "audio",
          modelId,
          llmClient: input.llmClient,
          db: input.db,
          contextMessages: input.contextMessages,
          currentText: input.currentText,
        });
        log.info("Added live input audio description", {
          path: getMediaBlockPath(block),
          modelId,
          descriptionLength: description.length,
        });
        await input.onAudioTranscriptionComplete?.({ block, modelId, transcription: description });
        augmented.push({ type: "text", text: description });
      } catch (error) {
        log.warn("Live input audio transcription failed", {
          path: getMediaBlockPath(block),
          modelId,
          error: errorToString(error),
        });
        await input.onAudioTranscriptionFailure?.({ block, modelId, error });
        // Keep the canonical audio block when translation fails.
      }
      continue;
    }

    augmented.push(block);
  }

  return augmented;
}

/**
 * Build a text-only representation of an incoming turn suitable for harness
 * live-input steering.
 * @param {{
 *   content: IncomingContentBlock[],
 *   llmClient: LlmClient,
 *   mediaToTextModels?: { image?: string, audio?: string, video?: string, general?: string },
 *   db: ChatDb,
 *   includeMediaReferences?: boolean,
 * } & LiveInputAudioTranscriptionObserver} input
 * @returns {Promise<string>}
 */
export async function buildLiveInputText(input) {
  const augmented = await augmentLiveInputBlocks(input.content, {
    llmClient: input.llmClient,
    mediaToTextModels: input.mediaToTextModels,
    db: input.db,
    contextMessages: [],
    currentText: extractTopLevelText(input.content),
    onAudioTranscriptionStart: input.onAudioTranscriptionStart,
    onAudioTranscriptionComplete: input.onAudioTranscriptionComplete,
    onAudioTranscriptionFailure: input.onAudioTranscriptionFailure,
  });
  return renderLiveInputPrompt(augmented, { includeMediaReferences: input.includeMediaReferences });
}
