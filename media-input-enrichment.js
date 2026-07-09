import { hasMediaPath } from "./attachment-paths.js";
import { contentHasContextResetCommand } from "./conversation/context-boundary.js";
import { getMediaTranslation, resolveMediaModel, formatMediaTranslationText } from "./media-to-text.js";
import { createLogger } from "./logger.js";
import { errorToString } from "./utils.js";

const log = createLogger("media-input-enrichment");
export const DEFAULT_MEDIA_INPUT_CONTEXT_MESSAGE_LIMIT = 20;

/**
 * @typedef {{
 *   block: AudioContentBlock,
 *   modelId: string,
 * }} MediaInputAudioTranscriptionStart
 *
 * @typedef {{
 *   block: AudioContentBlock,
 *   modelId: string,
 *   transcription: string,
 * }} MediaInputAudioTranscriptionComplete
 *
 * @typedef {{
 *   block: AudioContentBlock,
 *   modelId: string,
 *   error: unknown,
 * }} MediaInputAudioTranscriptionFailure
 *
 * @typedef {{
 *   onAudioTranscriptionStart?: (event: MediaInputAudioTranscriptionStart) => void | Promise<void>,
 *   onAudioTranscriptionComplete?: (event: MediaInputAudioTranscriptionComplete) => void | Promise<void>,
 *   onAudioTranscriptionFailure?: (event: MediaInputAudioTranscriptionFailure) => void | Promise<void>,
 * }} MediaInputAudioTranscriptionObserver
 *
 * @typedef {{
 *   llmClient: LlmClient,
 *   mediaToTextModels?: { image?: string, audio?: string, video?: string, general?: string },
 *   db: ChatDb,
 *   contextMessages: ChatMessage[],
 *   currentText: string,
 * }} MediaInputEnrichmentInput
 */

/**
 * @param {Array<IncomingContentBlock | ToolCallContentBlock>} blocks
 * @returns {string}
 */
export function extractTopLevelText(blocks) {
  return blocks
    .filter(/** @returns {block is TextContentBlock} */ (block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/**
 * Build light text-only context for media-to-text requests.
 * @param {Message[]} messages
 * @param {number} upToIndex
 * @param {{ limit?: number }} [options]
 * @returns {ChatMessage[]}
 */
export function buildMediaInputContextMessages(messages, upToIndex, options = {}) {
  /** @type {ChatMessage[]} */
  const contextMessages = [];
  const limit = Number.isInteger(options.limit) && Number(options.limit) > 0
    ? Number(options.limit)
    : null;
  let startIndex = 0;
  for (let i = 0; i < upToIndex; i++) {
    const message = messages[i];
    if (contentHasContextResetCommand(message.content)) {
      startIndex = i + 1;
    }
  }
  if (limit !== null) {
    startIndex = Math.max(startIndex, upToIndex - limit);
  }

  for (let i = startIndex; i < upToIndex; i++) {
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
 * @param {ImageContentBlock | VideoContentBlock | AudioContentBlock | FileContentBlock} block
 * @returns {string | null}
 */
function getMediaBlockPath(block) {
  return hasMediaPath(block) ? block.path : null;
}

/**
 * Create an ephemeral provider-ready view of incoming media blocks.
 * Canonical media blocks are preserved; generated image/video text is attached
 * as `alt`, while generated audio text is inserted as a labeled text block.
 * @param {IncomingContentBlock[]} blocks
 * @param {MediaInputEnrichmentInput & MediaInputAudioTranscriptionObserver} input
 * @returns {Promise<{ blocks: IncomingContentBlock[], changed: boolean }>}
 */
export async function enrichMediaInputBlocks(blocks, input) {
  /** @type {IncomingContentBlock[]} */
  const enriched = [];
  let changed = false;

  for (const block of blocks) {
    if (block.type === "quote") {
      const nested = await enrichMediaInputBlocks(block.content, input);
      enriched.push(nested.changed ? { ...block, content: nested.blocks } : block);
      changed ||= nested.changed;
      continue;
    }

    if (block.type === "image" || block.type === "video") {
      if (block.alt) {
        enriched.push(block);
        continue;
      }
      const modelId = resolveMediaModel(block.type, input.mediaToTextModels ?? {});
      if (!modelId) {
        log.info("Skipped media input enrichment; no model configured", {
          contentType: block.type,
          path: getMediaBlockPath(block),
        });
        enriched.push(block);
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
        log.info("Added media input description", {
          contentType: block.type,
          path: getMediaBlockPath(block),
          modelId,
          descriptionLength: alt.length,
        });
        enriched.push({ ...block, alt });
        changed = true;
      } catch (error) {
        log.warn("Media input enrichment failed", {
          contentType: block.type,
          path: getMediaBlockPath(block),
          modelId,
          error: errorToString(error),
        });
        enriched.push(block);
      }
      continue;
    }

    if (block.type === "audio") {
      enriched.push(block);
      const modelId = resolveMediaModel("audio", input.mediaToTextModels ?? {});
      if (!modelId) {
        log.info("Skipped audio input enrichment; no model configured", {
          path: getMediaBlockPath(block),
        });
        continue;
      }
      try {
        await input.onAudioTranscriptionStart?.({ block, modelId });
        const transcription = await getMediaTranslation({
          block,
          contentType: "audio",
          modelId,
          llmClient: input.llmClient,
          db: input.db,
          contextMessages: input.contextMessages,
          currentText: input.currentText,
        });
        log.info("Added audio input transcription", {
          path: getMediaBlockPath(block),
          modelId,
          descriptionLength: transcription.length,
        });
        await input.onAudioTranscriptionComplete?.({ block, modelId, transcription });
        enriched.push({ type: "text", text: formatMediaTranslationText("audio", transcription) });
        changed = true;
      } catch (error) {
        log.warn("Audio input enrichment failed", {
          path: getMediaBlockPath(block),
          modelId,
          error: errorToString(error),
        });
        await input.onAudioTranscriptionFailure?.({ block, modelId, error });
      }
      continue;
    }

    enriched.push(block);
  }

  return { blocks: enriched, changed };
}
