import config from "../config.js";
import { resolveChatModel } from "../model-roles.js";
import { buildSharedSkillPrompt, filterHarnessActions } from "../shared-skills.js";
import { buildRunConfig } from "./build-run-config.js";
import { buildRunSession } from "./build-run-session.js";
import { createToolRuntime } from "./create-tool-runtime.js";
import { prepareRunMessages } from "./prepare-run-messages.js";

/**
 * Build the external system instructions supplied by persona/chat settings and
 * per-turn conversation context. Harness defaults are applied later by each
 * harness.
 * @param {AgentDefinition | null} persona
 * @param {import("../store.js").ChatRow | undefined} chatInfo
 * @param {string} systemPromptSuffix
 * @param {string} harnessName
 * @returns {string}
 */
export function buildExternalSystemPrompt(persona, chatInfo, systemPromptSuffix, harnessName) {
  const explicitPrompt = persona?.systemPrompt ?? chatInfo?.system_prompt ?? "";
  if (explicitPrompt) {
    return `${explicitPrompt}${systemPromptSuffix}`;
  }
  if (harnessName === "native") {
    return `${config.system_prompt}${systemPromptSuffix}`;
  }
  return "";
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
 *   systemPromptSuffix: string,
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
  systemPromptSuffix,
  harnessName,
  resolvedBinding,
  bufferedTexts = [],
}) {
  const toolNames = persona?.allowedActions ?? null;
  const allowedTools = toolNames
    ? actions.filter((action) => toolNames.includes(action.name))
    : actions;
  const activeTools = filterHarnessActions(allowedTools, harnessName);

  /** @param {string} name */
  const resolveTool = async (name) => {
    const tool = await actionResolver(name);
    if (!tool) {
      return null;
    }
    if (toolNames && !toolNames.includes(tool.name)) {
      return null;
    }
    if (!filterHarnessActions([tool], harnessName).length) {
      return null;
    }
    return tool;
  };

  const chatModel = resolveChatModel(persona, chatInfo ?? undefined);
  const baseExternalInstructions = buildExternalSystemPrompt(persona, chatInfo, systemPromptSuffix, harnessName);
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
  const sharedSkillPrompt = harnessName === "codex"
    ? buildSharedSkillPrompt(activeTools)
    : "";
  const finalExternalInstructions = sharedSkillPrompt
    ? `${externalInstructions}${externalInstructions ? "\n\n" : ""}${sharedSkillPrompt}`
    : externalInstructions;

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
      externalInstructions: finalExternalInstructions,
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
