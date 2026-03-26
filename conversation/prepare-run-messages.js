import config from "../config.js";
import { getRootDb } from "../db.js";
import { contentEvent } from "../outbound-events.js";
import {
  extractTextFromMessage,
  findMemories,
  formatMemoriesContext,
} from "../memory.js";
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
 *   externalInstructions: string,
 *   context: Pick<ExecuteActionContext, "send">,
 * }} input
 * @returns {Promise<string>}
 */
async function searchAndAppendMemories({ chatId, chatInfo, message, llmClient, externalInstructions, context }) {
  const currentText = extractTextFromMessage(message);
  if (currentText.length < 10) {
    return externalInstructions;
  }

  try {
    const threshold = chatInfo?.memory_threshold ?? config.memory_threshold;
    const similar = await findMemories(getRootDb(), llmClient, chatId, currentText, { minSimilarity: threshold });
    log.debug(`[memory] query="${currentText.slice(0, 80)}" found=${similar.length} threshold=${threshold}`);

    if (similar.length === 0) {
      return externalInstructions;
    }

    const extended = externalInstructions + "\n\n## Relevant memories\n" + formatMemoriesContext(similar);
    log.debug("[memory] recalled:", similar.map((memory) => `#${memory.id}(${Number(memory.similarity).toFixed(3)})`).join(", "));

    const lines = similar.map((memory) =>
      `- [#${memory.id}] (score: ${Number(memory.similarity).toFixed(3)}) ${memory.content.slice(0, 100)}${memory.content.length > 100 ? "..." : ""}`
    );
    await context.send(contentEvent("memory", `Recalled ${similar.length} memor${similar.length === 1 ? "y" : "ies"}\n${lines.join("\n")}`));

    return extended;
  } catch (err) {
    log.error("Memory search failed:", err);
    return externalInstructions;
  }
}

/**
 * Prepare the prompt and messages that a harness run should see.
 * @param {{
 *   chatId: string,
 *   chatInfo: import("../store.js").ChatRow | undefined,
 *   message: UserMessage,
 *   llmClient: LlmClient,
 *   baseExternalInstructions: string,
 *   context: Pick<ExecuteActionContext, "send">,
 *   getMessages: import("../store.js").Store["getMessages"],
 *   bufferedTexts?: string[],
 * }} input
 * @returns {Promise<{ externalInstructions: string, messages: Message[], mediaRegistry: MediaRegistry }>}
 */
export async function prepareRunMessages({
  chatId,
  chatInfo,
  message,
  llmClient,
  baseExternalInstructions,
  context,
  getMessages,
  bufferedTexts = [],
}) {
  let externalInstructions = baseExternalInstructions;
  const chatMessages = await getMessages(chatId);

  if (chatInfo?.memory) {
    externalInstructions = await searchAndAppendMemories({
      chatId,
      chatInfo,
      message,
      llmClient,
      externalInstructions,
      context,
    });
  }

  const { messages, mediaRegistry } = prepareMessages(chatMessages);
  reattachHdDeferreds(chatId, mediaRegistry);

  for (const text of bufferedTexts) {
    if (!text) {
      continue;
    }
    messages.push({ role: "user", content: [{ type: "text", text }] });
    log.debug("Appended buffered message to conversation for chat", chatId);
  }

  return {
    externalInstructions,
    messages,
    mediaRegistry,
  };
}
