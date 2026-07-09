import { resolveChatModel } from "../model-roles.js";
import { prepareRunMessages } from "./prepare-run-messages.js";
import { buildLiveInputText } from "./live-input-text.js";
import { getChatDb } from "../db.js";
import {
  DEFAULT_MEDIA_INPUT_CONTEXT_MESSAGE_LIMIT,
  buildMediaInputContextMessages,
} from "../media-input-enrichment.js";

/**
 * Build the external system instructions supplied by persona/chat settings and
 * per-turn conversation context. Harness defaults are applied later by each
 * harness.
 * @param {AgentDefinition | null} persona
 * @param {import("../store.js").ChatRow | undefined} chatInfo
 * @param {string} _harnessName
 * @returns {string}
 */
export function buildExternalSystemPrompt(persona, chatInfo, _harnessName) {
  const explicitPrompt = persona?.systemPrompt ?? chatInfo?.system_prompt ?? "";
  if (explicitPrompt) {
    return explicitPrompt;
  }
  return "";
}

/**
 * Prepare provider-visible conversation input shared by turn request builders.
 * @param {{
 *   chatId: string,
 *   chatInfo: import("../store.js").ChatRow | undefined,
 *   context: ExecuteActionContext,
 *   message: UserMessage,
 *   persona: AgentDefinition | null,
 *   llmClient: LlmClient,
 *   getMessages: import("../store.js").Store["getMessages"],
 *   harnessName: string,
 *   bufferedTexts?: string[],
 * }} input
 * @returns {Promise<{
 *   chatModel: string,
 *   externalInstructions: string,
 *   messages: Message[],
 *   mediaRegistry: MediaRegistry,
 * }>}
 */
async function prepareHarnessConversationInput({
  chatId,
  chatInfo,
  context,
  message,
  persona,
  llmClient,
  getMessages,
  harnessName,
  bufferedTexts = [],
}) {
  const chatModel = resolveChatModel(persona, chatInfo ?? undefined);
  const baseExternalInstructions = buildExternalSystemPrompt(persona, chatInfo, harnessName);
  const { externalInstructions, messages, mediaRegistry } = await prepareRunMessages({
    chatId,
    chatInfo,
    message,
    llmClient,
    baseExternalInstructions,
    context,
    getMessages,
    bufferedTexts,
  });

  return {
    chatModel,
    externalInstructions,
    messages,
    mediaRegistry,
  };
}

/**
 * @param {Message[]} messages
 * @returns {{ message: UserMessage, index: number } | null}
 */
function getLatestUserMessage(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user") {
      return { message, index };
    }
  }
  return null;
}

/**
 * @param {string} harnessName
 * @returns {boolean}
 */
function usesSemanticAcpContent(harnessName) {
  return harnessName === "acp" || harnessName === "codex" || harnessName === "claude" || harnessName === "pi";
}

/**
 * Build the semantic provider turn input for a chat turn.
 * @param {{
 *   chatId: string,
 *   chatInfo: import("../store.js").ChatRow | undefined,
 *   context: ExecuteActionContext,
 *   message: UserMessage,
 *   persona: AgentDefinition | null,
 *   llmClient: LlmClient,
 *   getMessages: import("../store.js").Store["getMessages"],
 *   harnessName: string,
 *   runConfig: HarnessRunConfig,
 *   bufferedTexts?: string[],
 *   prebuiltInputText?: string,
 *   audioTranscriptionObserver?: {
 *     onAudioTranscriptionStart?: (event: { block: AudioContentBlock, modelId: string }) => void | Promise<void>,
 *     onAudioTranscriptionComplete?: (event: { block: AudioContentBlock, modelId: string, transcription: string }) => void | Promise<void>,
 *     onAudioTranscriptionFailure?: (event: { block: AudioContentBlock, modelId: string, error: unknown }) => void | Promise<void>,
 *   },
 * }} input
 * @returns {Promise<HarnessTurnInput>}
 */
export async function buildHarnessTurnInput({
  chatId,
  chatInfo,
  context,
  message,
  persona,
  llmClient,
  getMessages,
  harnessName,
  runConfig,
  bufferedTexts = [],
  prebuiltInputText,
  audioTranscriptionObserver,
}) {
  const { externalInstructions, messages } = await prepareHarnessConversationInput({
    chatId,
    chatInfo,
    context,
    message,
    persona,
    llmClient,
    getMessages,
    harnessName,
    bufferedTexts,
  });
  const latestUser = getLatestUserMessage(messages);
  const inputText = prebuiltInputText ?? await buildLiveInputText({
    content: latestUser?.message.content ?? [],
    llmClient,
    mediaToTextModels: chatInfo?.media_to_text_models ?? {},
    db: getChatDb(chatId),
    contextMessages: latestUser
      ? buildMediaInputContextMessages(messages, latestUser.index, {
        limit: DEFAULT_MEDIA_INPUT_CONTEXT_MESSAGE_LIMIT,
      })
      : [],
    includeMediaReferences: !usesSemanticAcpContent(harnessName),
    onAudioTranscriptionStart: audioTranscriptionObserver?.onAudioTranscriptionStart,
    onAudioTranscriptionComplete: audioTranscriptionObserver?.onAudioTranscriptionComplete,
    onAudioTranscriptionFailure: audioTranscriptionObserver?.onAudioTranscriptionFailure,
  });

  return {
    chatId,
    input: inputText,
    messages,
    externalInstructions,
    runConfig,
  };
}
