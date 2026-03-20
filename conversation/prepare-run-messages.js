import config from "../config.js";
import { getRootDb } from "../db.js";
import {
  extractTextFromMessage,
  findMemories,
  formatMemoriesContext,
} from "../memory.js";
import { convertUnsupportedMedia } from "../media-to-text.js";
import { prepareMessages } from "../message-formatting.js";
import { reattachHdDeferreds } from "../whatsapp-hd-media.js";
import { createLogger } from "../logger.js";

const log = createLogger("conversation:prepare-run-messages");

/**
 * Search long-term memory for relevant context and append it to the system prompt.
 * @param {{
 *   chatId: string,
 *   chatInfo: import("../store.js").ChatRow | undefined,
 *   message: UserMessage,
 *   llmClient: LlmClient,
 *   systemPrompt: string,
 *   context: Pick<ExecuteActionContext, "send">,
 * }} input
 * @returns {Promise<string>}
 */
async function searchAndAppendMemories({ chatId, chatInfo, message, llmClient, systemPrompt, context }) {
  const currentText = extractTextFromMessage(message);
  if (currentText.length < 10) {
    return systemPrompt;
  }

  try {
    const threshold = chatInfo?.memory_threshold ?? config.memory_threshold;
    const similar = await findMemories(getRootDb(), llmClient, chatId, currentText, { minSimilarity: threshold });
    log.debug(`[memory] query="${currentText.slice(0, 80)}" found=${similar.length} threshold=${threshold}`);

    if (similar.length === 0) {
      return systemPrompt;
    }

    const extended = systemPrompt + "\n\n## Relevant memories\n" + formatMemoriesContext(similar);
    log.debug("[memory] recalled:", similar.map((memory) => `#${memory.id}(${Number(memory.similarity).toFixed(3)})`).join(", "));

    const lines = similar.map((memory) =>
      `- [#${memory.id}] (score: ${Number(memory.similarity).toFixed(3)}) ${memory.content.slice(0, 100)}${memory.content.length > 100 ? "..." : ""}`
    );
    await context.send("memory", `Recalled ${similar.length} memor${similar.length === 1 ? "y" : "ies"}\n${lines.join("\n")}`);

    return extended;
  } catch (err) {
    log.error("Memory search failed:", err);
    return systemPrompt;
  }
}

/**
 * Prepare the prompt and messages that a harness run should see.
 * @param {{
 *   chatId: string,
 *   chatInfo: import("../store.js").ChatRow | undefined,
 *   message: UserMessage,
 *   llmClient: LlmClient,
 *   chatModel: string,
 *   baseSystemPrompt: string,
 *   context: Pick<ExecuteActionContext, "send">,
 *   getMessages: import("../store.js").Store["getMessages"],
 *   bufferedTexts?: string[],
 * }} input
 * @returns {Promise<{ systemPrompt: string, messages: Message[], mediaRegistry: MediaRegistry }>}
 */
export async function prepareRunMessages({
  chatId,
  chatInfo,
  message,
  llmClient,
  chatModel,
  baseSystemPrompt,
  context,
  getMessages,
  bufferedTexts = [],
}) {
  let systemPrompt = baseSystemPrompt;
  const chatMessages = await getMessages(chatId);
  const mediaToTextModels = chatInfo?.media_to_text_models ?? {};
  const rootDb = getRootDb();
  const { messages: translatedMessages, skippedTypes } = await convertUnsupportedMedia(
    chatMessages,
    chatModel,
    mediaToTextModels,
    llmClient,
    rootDb,
  );

  if (skippedTypes.size > 0) {
    const types = [...skippedTypes].join(", ");
    await context.send("warning", `${types} not supported by this model. Use \`!config media_to_text_model\` to enable.`);
  }

  if (chatInfo?.memory) {
    systemPrompt = await searchAndAppendMemories({
      chatId,
      chatInfo,
      message,
      llmClient,
      systemPrompt,
      context,
    });
  }

  const { messages, mediaRegistry } = prepareMessages(translatedMessages);
  reattachHdDeferreds(chatId, mediaRegistry);

  for (const text of bufferedTexts) {
    if (!text) {
      continue;
    }
    messages.push({ role: "user", content: [{ type: "text", text }] });
    log.debug("Appended buffered message to conversation for chat", chatId);
  }

  return {
    systemPrompt,
    messages,
    mediaRegistry,
  };
}
