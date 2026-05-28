import { resolveChatModel } from "../model-roles.js";
import { buildRunConfig } from "./build-run-config.js";
import { buildRunSession } from "./build-run-session.js";
import { createToolRuntime } from "./create-tool-runtime.js";
import { prepareRunMessages } from "./prepare-run-messages.js";
import { buildLiveInputText } from "./live-input-text.js";
import { getChatDb } from "../db.js";

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
 * @returns {IncomingContentBlock[]}
 */
function getLatestUserContent(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user") {
      return message.content;
    }
  }
  return [];
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

  return {
    chatId,
    input: await buildLiveInputText({
      content: getLatestUserContent(messages),
      llmClient,
      mediaToTextModels: chatInfo?.media_to_text_models ?? {},
      db: getChatDb(chatId),
    }),
    messages,
    externalInstructions,
    runConfig,
  };
}

/**
 * Build the full harness run request for a chat turn.
 * @param {{
 *   chatId: string,
 *   senderIds: string[],
 *   chatInfo: import("../store.js").ChatRow | undefined,
 *   chatName?: string,
 *   context: ExecuteActionContext,
 *   message: UserMessage,
 *   persona: AgentDefinition | null,
 *   actions: Action[],
 *   actionResolver: (name: string) => Promise<AppAction | null>,
 *   llmClient: LlmClient,
 *   getMessages: import("../store.js").Store["getMessages"],
 *   executeActionFn: typeof import("../actions.js").executeAction,
 *   addMessage: Session["addMessage"],
 *   updateToolMessage: Session["updateToolMessage"],
 *   saveHarnessSession: import("../store.js").Store["saveHarnessSession"],
 *   hooks: AgentIOHooks,
 *   harnessName: string,
 *   resolvedBinding?: ResolvedChatBinding,
 *   bufferedTexts?: string[],
 * }} input
 * @returns {Promise<AgentHarnessParams>}
 */
export async function buildHarnessRunRequest({
  chatId,
  senderIds,
  chatInfo,
  chatName,
  context,
  message,
  persona,
  actions,
  actionResolver,
  llmClient,
  getMessages,
  executeActionFn,
  addMessage,
  updateToolMessage,
  saveHarnessSession,
  hooks,
  harnessName,
  resolvedBinding,
  bufferedTexts = [],
}) {
  const toolNames = persona?.allowedActions ?? null;
  const allowedTools = toolNames
    ? actions.filter((action) => toolNames.includes(action.name))
    : actions;
  const activeTools = allowedTools;

  /** @param {string} name */
  const resolveTool = async (name) => {
    const tool = await actionResolver(name);
    if (!tool) {
      return null;
    }
    if (toolNames && !toolNames.includes(tool.name)) {
      return null;
    }
    return tool;
  };

  const { chatModel, externalInstructions, messages, mediaRegistry } = await prepareHarnessConversationInput({
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

  return {
    session: buildRunSession({
      chatId,
      senderIds,
      chatInfo,
      context,
      addMessage,
      updateToolMessage,
      saveHarnessSession,
    }),
    llmConfig: {
      llmClient,
      chatModel,
      externalInstructions,
      mediaToTextModels: chatInfo?.media_to_text_models ?? {},
      toolRuntime: createToolRuntime({
        tools: activeTools,
        resolveTool,
        executeActionFn,
        llmClient,
      }),
    },
    messages,
    mediaRegistry,
    hooks,
    runConfig: buildRunConfig(chatId, chatInfo, chatName, harnessName, resolvedBinding),
  };
}
