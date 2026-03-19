import config from "../config.js";
import { getAgent } from "../agents.js";
import { getRootDb } from "../db.js";
import { resolveHarness, resolveHarnessName } from "../harnesses/index.js";
import {
  extractTextFromMessage,
  findMemories,
  formatMemoriesContext,
} from "../memory.js";
import { convertUnsupportedMedia } from "../media-to-text.js";
import { prepareMessages } from "../message-formatting.js";
import { resolveChatModel } from "../model-roles.js";
import { getChatWorkDir } from "../utils.js";
import { reattachHdDeferreds } from "../whatsapp-hd-media.js";
import { createLogger } from "../logger.js";

const log = createLogger("conversation:build-run-request");

/**
 * Search long-term memory for relevant context and append to system prompt.
 * Returns the (possibly extended) system prompt.
 * @param {object} opts
 * @param {string} opts.chatId
 * @param {import("../store.js").ChatRow | undefined} opts.chatInfo
 * @param {UserMessage} opts.message
 * @param {LlmClient} opts.llmClient
 * @param {string} opts.systemPrompt
 * @param {Pick<ExecuteActionContext, "send">} opts.context
 * @returns {Promise<string>}
 */
async function searchAndAppendMemories({ chatId, chatInfo, message, llmClient, systemPrompt, context }) {
  const currentText = extractTextFromMessage(message);
  if (currentText.length < 10) return systemPrompt;

  try {
    const threshold = chatInfo?.memory_threshold ?? config.memory_threshold;
    const similar = await findMemories(getRootDb(), llmClient, chatId, currentText, { minSimilarity: threshold });
    log.debug(`[memory] query="${currentText.slice(0, 80)}" found=${similar.length} threshold=${threshold}`);
    if (similar.length > 0) {
      const extended = systemPrompt + "\n\n## Relevant memories\n" + formatMemoriesContext(similar);
      log.debug("[memory] recalled:", similar.map(m => `#${m.id}(${Number(m.similarity).toFixed(3)})`).join(", "));
      const lines = similar.map(m =>
        `• [#${m.id}] (score: ${Number(m.similarity).toFixed(3)}) ${m.content.slice(0, 100)}${m.content.length > 100 ? "…" : ""}`
      );
      await context.send("memory", `Recalled ${similar.length} memor${similar.length === 1 ? "y" : "ies"}\n${lines.join("\n")}`);
      return extended;
    }
  } catch (err) {
    log.error("Memory search failed:", err);
  }
  return systemPrompt;
}

/**
 * Build the full harness run request for a chat turn.
 * @param {{
 *   chatId: string,
 *   senderIds: string[],
 *   chatInfo: import("../store.js").ChatRow | undefined,
 *   context: ExecuteActionContext,
 *   message: UserMessage,
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
 * @returns {Promise<{ harness: AgentHarness, runRequest: AgentHarnessParams }>}
 */
export async function buildHarnessRunRequest({
  chatId,
  senderIds,
  chatInfo,
  context,
  message,
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
  const persona = chatInfo?.active_persona ? await getAgent(chatInfo.active_persona) : null;
  const harnessName = resolveHarnessName(persona, chatInfo);
  const harness = resolveHarness(harnessName);

  let systemPrompt = (persona?.systemPrompt ?? chatInfo?.system_prompt ?? config.system_prompt) + systemPromptSuffix;
  const chatModel = resolveChatModel(persona, chatInfo ?? undefined);

  const chatMessages = await getMessages(chatId);
  const mediaToTextModels = chatInfo?.media_to_text_models ?? {};
  const rootDb = getRootDb();
  const { messages: translatedMessages, skippedTypes } = await convertUnsupportedMedia(
    chatMessages, chatModel, mediaToTextModels, llmClient, rootDb,
  );

  if (skippedTypes.size > 0) {
    const types = [...skippedTypes].join(", ");
    await context.send("warning", `${types} not supported by this model. Use \`!config media_to_text_model\` to enable.`);
  }

  if (chatInfo?.memory) {
    systemPrompt = await searchAndAppendMemories({ chatId, chatInfo, message, llmClient, systemPrompt, context });
  }

  const { messages: preparedMessages, mediaRegistry } = prepareMessages(translatedMessages);
  reattachHdDeferreds(chatId, mediaRegistry);

  for (const text of bufferedTexts) {
    if (!text) continue;
    preparedMessages.push({ role: "user", content: [{ type: "text", text }] });
    log.debug("Appended buffered message to conversation for chat", chatId);
  }

  /** @type {Session} */
  const session = {
    chatId,
    senderIds,
    context,
    addMessage,
    updateToolMessage,
    harnessSession: chatInfo?.harness_session_id && chatInfo?.harness_session_kind
      ? { id: chatInfo.harness_session_id, kind: chatInfo.harness_session_kind }
      : null,
    saveHarnessSession,
  };

  const activeActions = persona?.allowedActions
    ? actions.filter(a => persona.allowedActions?.includes(a.name))
    : actions;

  /** @type {LlmConfig} */
  const llmConfig = {
    llmClient,
    chatModel,
    systemPrompt,
    actions: activeActions,
    executeActionFn,
    actionResolver,
    actionLlmClient: llmClient,
  };

  return {
    harness,
    runRequest: {
      session,
      llmConfig,
      messages: preparedMessages,
      mediaRegistry,
      hooks,
      runConfig: {
        workdir: getChatWorkDir(chatId, chatInfo?.harness_cwd),
        model: chatInfo?.harness_config?.model ?? undefined,
        reasoningEffort: /** @type {HarnessRunConfig["reasoningEffort"]} */ (chatInfo?.harness_config?.reasoningEffort ?? undefined),
        sandboxMode: /** @type {HarnessRunConfig["sandboxMode"]} */ (chatInfo?.harness_config?.sandboxMode ?? undefined),
        approvalPolicy: /** @type {HarnessRunConfig["approvalPolicy"]} */ (chatInfo?.harness_config?.approvalPolicy ?? undefined),
      },
    },
  };
}
