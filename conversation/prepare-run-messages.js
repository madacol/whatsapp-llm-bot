import config from "../config.js";
import { getChatDb } from "../db.js";
import { createAppOutputPort } from "../app-output-port.js";
import {
  extractTextFromMessage,
  findMemories,
  formatMemoriesContext,
} from "../memory.js";
import { prepareMessages } from "../message-formatting.js";
import { createLogger } from "../logger.js";
import { ensureChatStoreSchema } from "../store/schema/chat.js";

const log = createLogger("conversation:prepare-run-messages");

/**
 * Search long-term memory for relevant context and append it to the system prompt.
 * @param {{
 *   chatId: string,
 *   chatInfo: import("../store.js").ChatRow | undefined,
 *   message: UserMessage,
 *   llmClient: LlmClient,
 *   externalInstructions: string,
 *   context: Pick<ExecuteActionContext, "send" | "reply">,
 * }} input
 * @returns {Promise<string>}
 */
async function searchAndAppendMemories({ chatId, chatInfo, message, llmClient, externalInstructions, context }) {
  const appOutput = createAppOutputPort(context);
  const currentText = extractTextFromMessage(message);
  if (currentText.length < 10) {
    return externalInstructions;
  }

  try {
    const threshold = chatInfo?.memory_threshold ?? config.memory_threshold;
    const chatDb = getChatDb(chatId);
    await ensureChatStoreSchema(chatDb);
    const similar = await findMemories(chatDb, llmClient, chatId, currentText, { minSimilarity: threshold });
    log.debug(`[memory] query="${currentText.slice(0, 80)}" found=${similar.length} threshold=${threshold}`);

    if (similar.length === 0) {
      return externalInstructions;
    }

    const extended = externalInstructions + "\n\n## Relevant memories\n" + formatMemoriesContext(similar);
    log.debug("[memory] recalled:", similar.map((memory) => `#${memory.id}(${Number(memory.similarity).toFixed(3)})`).join(", "));

    const lines = similar.map((memory) =>
      `- [#${memory.id}] (score: ${Number(memory.similarity).toFixed(3)}) ${memory.content.slice(0, 100)}${memory.content.length > 100 ? "..." : ""}`
    );
    await appOutput.sendMemory(`Recalled ${similar.length} memor${similar.length === 1 ? "y" : "ies"}\n${lines.join("\n")}`);

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
 *   context: Pick<ExecuteActionContext, "send" | "reply" | "prepareMediaRegistry">,
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
  await context.prepareMediaRegistry?.({ chatId, messages, mediaRegistry });

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
