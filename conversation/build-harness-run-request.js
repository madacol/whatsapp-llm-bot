import config from "../config.js";
import { resolveChatModel } from "../model-roles.js";
import { buildRunConfig } from "./build-run-config.js";
import { buildRunSession } from "./build-run-session.js";
import { createToolRuntime } from "./create-tool-runtime.js";
import { prepareRunMessages } from "./prepare-run-messages.js";

/**
 * Build the full harness run request for a chat turn.
 * @param {{
 *   chatId: string,
 *   senderIds: string[],
 *   chatInfo: import("../store.js").ChatRow | undefined,
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
 *   bufferedTexts?: string[],
 * }} input
 * @returns {Promise<AgentHarnessParams>}
 */
export async function buildHarnessRunRequest({
  chatId,
  senderIds,
  chatInfo,
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
  bufferedTexts = [],
}) {
  const toolNames = persona?.allowedActions ?? null;
  const activeTools = toolNames
    ? actions.filter((action) => toolNames.includes(action.name))
    : actions;

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

  const chatModel = resolveChatModel(persona, chatInfo ?? undefined);
  const baseSystemPrompt = (persona?.systemPrompt ?? chatInfo?.system_prompt ?? config.system_prompt) + systemPromptSuffix;
  const { systemPrompt, messages, mediaRegistry } = await prepareRunMessages({
    chatId,
    chatInfo,
    message,
    llmClient,
    chatModel,
    baseSystemPrompt,
    context,
    getMessages,
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
      systemPrompt,
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
    runConfig: buildRunConfig(chatId, chatInfo),
  };
}
