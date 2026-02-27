/**
 * WhatsApp LLM Bot with JavaScript execution capabilities
 */

import OpenAI from "openai";
import { getActions, executeAction, getChatActions, getChatAction, getAction } from "./actions.js";
import config from "./config.js";
import { createLlmClient } from "./llm.js";
import { shortenToolId, formatTime, truncateWithSummary, isHtmlContent } from "./utils.js";
import { connectToWhatsApp } from "./whatsapp-adapter.js";
import { startReminderDaemon } from "./reminder-daemon.js";
import { startModelsCacheDaemon } from "./models-cache.js";
import { initStore } from "./store.js";
import {
  actionsToOpenAIFormat,
  shouldRespond,
  formatUserMessage,
  parseCommandArgs,
  formatMessagesForOpenAI,
} from "./message-formatting.js";
import { convertUnsupportedMedia } from "./media-to-text.js";
import { getRootDb } from "./db.js";
import {
  extractTextFromMessage,
  findMemories,
  formatMemoriesContext,
} from "./memory.js";
import { storeLlmContext } from "./context-log.js";
import { storePage } from "./html-store.js";
import { startHtmlServer, stopHtmlServer } from "./html-server.js";

/**
 * Type guard: checks that an action has a command string.
 * @param {Action} a
 * @returns {a is Action & {command: string}}
 */
function hasCommand(a) {
  return typeof a.command === "string";
}

const MAX_TOOL_CALL_DEPTH = 10;

/**
 * Display a tool call to the user (compact or verbose based on debug mode).
 * @param {OpenAI.Chat.Completions.ChatCompletionMessageToolCall} toolCall
 * @param {Context} context
 * @param {((params: Record<string, any>) => string)} [formatToolCall] - Optional formatter from the action
 */
async function displayToolCall(toolCall, context, formatToolCall) {
  if (!context.isDebug) {
    let compactMsg = `🔧 ${toolCall.function.name}`;
    if (formatToolCall) {
      const args = parseToolArgs(toolCall.function.arguments);
      compactMsg += `: ${formatToolCall(args)}`;
    }
    await context.sendMessage(compactMsg);
    return;
  }

  const shortId = shortenToolId(toolCall.id);
  const args = parseToolArgs(toolCall.function.arguments);
  const argEntries = Object.entries(args);
  const header = `🔧 *${toolCall.function.name}*    [${shortId}]`;

  if (argEntries.length === 0) {
    await context.sendMessage(header);
  } else if (argEntries.length === 1 && typeof argEntries[0][1] === "string" && argEntries[0][1].length <= 60) {
    await context.sendMessage(header, `*${argEntries[0][0]}*: ${argEntries[0][1]}`);
  } else {
    const parts = argEntries.map(([k, v]) => {
      if (typeof v === "string" && v.includes("\n")) {
        return `*${k}*:\n\`\`\`\n${v}\n\`\`\``;
      }
      const val = typeof v === "string" ? v : JSON.stringify(v, null, 2);
      return `*${k}*: ${val}`;
    });
    await context.sendMessage(header, parts.join("\n\n"));
  }
}

/**
 * Display a tool result to the user (compact, verbose, or silent).
 * @param {string} resultMessage - The stringified result
 * @param {string} shortId - Shortened tool call ID
 * @param {Action['permissions']} permissions - Action permission flags
 * @param {Context} context
 */
async function displayToolResult(resultMessage, shortId, permissions, context) {
  if (permissions.silent) return;

  if (context.isDebug) {
    await context.sendMessage(`✅ *Result*    [${shortId}]`, resultMessage);
  } else if (permissions.autoContinue) {
    await context.sendMessage(`✅ ${truncateWithSummary(resultMessage, 200)}`);
  } else {
    // Non-autoContinue: this is the final answer, show full result as reply
    await context.reply(resultMessage);
  }
}

/**
 * Parse tool call arguments from JSON string, with error fallback.
 * @param {string} argsString
 * @returns {{}}
 */
function parseToolArgs(argsString) {
  try {
    return JSON.parse(argsString || "{}");
  } catch {
    console.error("Failed to parse tool call arguments:", argsString);
    return {};
  }
}

/**
 * @typedef {{
 *   chatId: string,
 *   senderIds: string[],
 *   context: Context,
 *   addMessage: Store['addMessage'],
 * }} Session
 *
 * @typedef {{
 *   llmClient: OpenAI,
 *   chatModel: string,
 *   systemPrompt: string,
 *   actions: Action[],
 *   executeActionFn: typeof executeAction,
 *   actionResolver: (name: string) => Promise<AppAction | null>,
 *   actionLlmClient: import("openai").default,
 * }} LlmConfig
 */

/**
 * Execute a single tool call: run action, store result, display to user.
 * Returns whether processing should continue (autoContinue or error).
 * @param {{
 *   session: Session,
 *   llmConfig: LlmConfig,
 *   toolCall: OpenAI.Chat.Completions.ChatCompletionMessageToolCall,
 *   formattedMessages: Array<OpenAI.ChatCompletionMessageParam>,
 * }} params
 * @returns {Promise<boolean>} Whether to continue processing (loop again)
 */
async function executeAndStoreTool({
  session, llmConfig, toolCall, formattedMessages,
}) {
  const { chatId, senderIds, context, addMessage } = session;
  const { executeActionFn, actionResolver, actionLlmClient } = llmConfig;
  const toolName = toolCall.function.name;
  const toolArgs = parseToolArgs(toolCall.function.arguments);
  const shortId = shortenToolId(toolCall.id);
  console.log("executing", toolName, toolArgs);

  try {
    const functionResponse = await executeActionFn(
      toolName, context, toolArgs, toolCall.id, actionResolver, actionLlmClient,
    );
    console.log("response", functionResponse);

    const result = functionResponse.result;

    // HTML content → store page, send link, treat as text for LLM context
    if (isHtmlContent(result)) {
      const pageId = await storePage(getRootDb(), result.html, result.title);
      const baseUrl = config.html_server_base_url || `http://localhost:${config.html_server_port}`;
      const pageUrl = `${baseUrl}/page/${pageId}`;
      const linkText = result.title ? `${result.title}: ${pageUrl}` : pageUrl;

      /** @type {ToolMessage} */
      const toolMessage = {
        role: "tool",
        tool_id: toolCall.id,
        content: [{ type: "text", text: linkText }],
      };
      await addMessage(chatId, toolMessage, senderIds);
      await displayToolResult(linkText, shortId, functionResponse.permissions, context);

      /** @type {OpenAI.ChatCompletionMessageParam} */
      const toolResultMessage = { role: "tool", tool_call_id: toolCall.id, content: linkText };
      formattedMessages.push(toolResultMessage);

      return !!functionResponse.permissions.autoContinue;
    }

    const isContentBlocks = Array.isArray(result)
      && result.length > 0
      && typeof result[0] === "object"
      && "type" in result[0];

    // Store tool result (silent tools get a stub to satisfy API pairing)
    /** @type {ToolMessage} */
    const toolMessage = {
      role: "tool",
      tool_id: toolCall.id,
      content: functionResponse.permissions.silent
        ? [{ type: "text", text: "[recalled prior messages]" }]
        : isContentBlocks
          ? /** @type {ToolContentBlock[]} */ (result)
          : [{ type: "text", text: JSON.stringify(result) }],
    };
    await addMessage(chatId, toolMessage, senderIds);

    const resultMessage = isContentBlocks
      ? /** @type {ToolContentBlock[]} */ (result)
          .filter((b) => b.type === "text")
          .map((b) => /** @type {TextContentBlock} */ (b).text)
          .join("\n") || "Done."
      : typeof result === "string"
        ? result
        : JSON.stringify(result, null, 2);

    await displayToolResult(resultMessage, shortId, functionResponse.permissions, context);

    /** @type {OpenAI.ChatCompletionMessageParam} */
    const toolResultMessage = { role: "tool", tool_call_id: toolCall.id, content: resultMessage };
    formattedMessages.push(toolResultMessage);

    return !!functionResponse.permissions.autoContinue;
  } catch (error) {
    console.error("Error executing tool:", error);
    const errorMessage = `Error executing ${toolName}: ${error instanceof Error ? error.message : String(error)}`;

    /** @type {ToolMessage} */
    const toolError = {
      role: "tool",
      tool_id: toolCall.id,
      content: [{type: "text", text: errorMessage}],
    };
    await addMessage(chatId, toolError, senderIds);

    if (context.isDebug) {
      await context.sendMessage(`❌ *Tool Error*    [${shortId}]`, errorMessage);
    } else {
      await context.sendMessage(`❌ [${shortId}] ${errorMessage}`);
    }

    /** @type {OpenAI.ChatCompletionMessageParam} */
    const toolResultMessage = { role: "tool", tool_call_id: toolCall.id, content: errorMessage };
    formattedMessages.push(toolResultMessage);

    // Errors always auto-continue for self-correction
    return true;
  }
}

/**
 * Process LLM responses, handling tool calls in a loop with depth guard.
 * @param {{
 *   session: Session,
 *   llmConfig: LlmConfig,
 *   formattedMessages: Array<OpenAI.ChatCompletionMessageParam>,
 * }} params
 */
async function processLlmResponse({ session, llmConfig, formattedMessages }) {
  const { chatId, senderIds, context, addMessage } = session;
  const { llmClient, chatModel, actions } = llmConfig;
  let { systemPrompt } = llmConfig;
  const injectedActions = new Set();
  let depth = 0;

  while (depth < MAX_TOOL_CALL_DEPTH) {
    let response;
    try {
      response = await llmClient.chat.completions.create({
        model: chatModel,
        messages: [
          { role: "system", content: /** @type {Array<{type: "text", text: string, cache_control: {type: "ephemeral"}}>} */ ([{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }]) },
          ...formattedMessages,
        ],
        tools: actionsToOpenAIFormat(actions),
        tool_choice: "auto",
      });
    } catch (error) {
      console.error(error);
      const errorMessage = JSON.stringify(error, null, 2);
      await context.reply(
        "❌ *Error*",
        "An error occurred while processing the message.\n\n" + errorMessage,
      );
      return;
    }

    if (response.usage) {
      const cached = response.usage.prompt_tokens_details?.cached_tokens ?? 0;
      const prompt = response.usage.prompt_tokens;
      const completion = response.usage.completion_tokens;
      console.log(`[LLM usage] prompt=${prompt} cached=${cached} completion=${completion} model=${chatModel}`);
    }

    const responseMessage = response.choices[0].message;

    /** @type {AssistantMessage} */
    const assistantMessage = { role: "assistant", content: [] };

    if (responseMessage.content) {
      console.log("RESPONSE SENT:", responseMessage.content);
      await context.reply("🤖 *AI Assistant*", responseMessage.content);
      assistantMessage.content.push({ type: "text", text: responseMessage.content });
    }

    if (!responseMessage.tool_calls) {
      formattedMessages.push(responseMessage);
      const storedAssistant = await addMessage(chatId, assistantMessage, senderIds);
      if (depth === 0) {
        storeLlmContext(getRootDb(), storedAssistant.message_id, chatModel, systemPrompt, formattedMessages, actions);
      }
      return;
    }

    // Record and display tool calls
    for (const toolCall of responseMessage.tool_calls) {
      assistantMessage.content.push({
        type: "tool",
        tool_id: toolCall.id,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      });
      const action = actions.find(a => a.name === toolCall.function.name);
      await displayToolCall(toolCall, context, action?.formatToolCall);
    }

    const storedAssistantWithTools = await addMessage(chatId, assistantMessage, senderIds);
    if (depth === 0) {
      storeLlmContext(getRootDb(), storedAssistantWithTools.message_id, chatModel, systemPrompt, formattedMessages, actions);
    }
    formattedMessages.push(responseMessage);

    // Execute each tool call
    let continueProcessing = false;
    for (const toolCall of responseMessage.tool_calls) {
      const shouldContinue = await executeAndStoreTool({
        session, llmConfig, toolCall, formattedMessages,
      });
      if (shouldContinue) continueProcessing = true;
    }

    // Inject detailed instructions for newly-used actions into the system prompt
    for (const toolCall of responseMessage.tool_calls) {
      const name = toolCall.function.name;
      if (injectedActions.has(name)) continue;
      const action = actions.find(a => a.name === name);
      if (action?.instructions) {
        systemPrompt += `\n\n## ${action.name} instructions\n${action.instructions}`;
        injectedActions.add(name);
      }
    }

    if (!continueProcessing) return;
    depth++;
  }

  await context.reply(
    "⚠️ *Depth limit*",
    `Reached maximum tool call depth (${MAX_TOOL_CALL_DEPTH}). Stopping.`,
  );
}

/**
 * @typedef {import('./store.js').Store} Store
 *
 * @typedef {{
 *   store: Store,
 *   llmClient: OpenAI,
 *   getActionsFn: typeof getActions,
 *   executeActionFn: typeof executeAction,
 * }} MessageHandlerDeps
 */

/**
 * Create a message handler with injected dependencies.
 * @param {MessageHandlerDeps} deps
 * @returns {{ handleMessage: (messageContext: IncomingContext) => Promise<void> }}
 */
export function createMessageHandler({ store, llmClient, getActionsFn, executeActionFn }) {
  const { addMessage, createChat, getChat, getMessages } = store;

  /**
   * Handle incoming WhatsApp messages
   * @param {IncomingContext} messageContext
   * @returns {Promise<void>}
   */
  async function handleMessage(messageContext) {
    const { chatId, senderIds, content, isGroup, senderName, selfIds, quotedSenderId } = messageContext;

    console.log("INCOMING MESSAGE:", JSON.stringify(messageContext, null, 2));

    // Ensure chat exists in DB for both command and message paths
    await createChat(chatId);

    // Compute debug state before building context so it's immutable
    const chatInfo = await getChat(chatId);
    const isDebug = !!chatInfo?.debug_until && new Date(chatInfo.debug_until) > new Date();

    /** @type {Context} */
    const context = {
      chatId,
      senderIds,
      content,
      isDebug,
      getIsAdmin: async () => {
        const adminStatus = await messageContext.getAdminStatus();
        return adminStatus === "admin" || adminStatus === "superadmin";
      },
      sendMessage: async (header, text) => {
        const fullMessage = text ? `${header}\n\n${text}` : header;
        await messageContext.sendMessage(fullMessage);
      },
      reply: async (header, text) => {
        const fullMessage = text ? `${header}\n\n${text}` : header;
        await messageContext.replyToMessage(fullMessage);
      },
      reactToMessage: messageContext.reactToMessage,
      sendPoll: messageContext.sendPoll,
      sendImage: messageContext.sendImage,
      sendVideo: messageContext.sendVideo,
      confirm: messageContext.confirm,
    };

    // Load actions (global + chat-scoped), filtering out opt-in actions not enabled for this chat
    const globalActions = await getActionsFn();
    const chatActions = await getChatActions(chatId);
    const enabledActions = chatInfo?.enabled_actions ?? [];
    /** @type {Action[]} */
    const actions = [...globalActions, ...chatActions].filter(
      (a) => !a.optIn || enabledActions.includes(a.name),
    );

    /** @param {string} name */
    const actionResolver = async (name) => {
      const chatAction = await getChatAction(chatId, name);
      if (chatAction) return chatAction;
      return getAction(name);
    };

    const firstBlock = content.find(block=>block.type === "text")

    if (firstBlock?.text?.startsWith("!")) {
      const inputText = firstBlock.text.slice(1).trim();
      const commandText = inputText.toLowerCase();

      // Sort commands longest-first so "set model" matches before hypothetical "set"
      const commandActions = actions.filter(hasCommand);
      const action = commandActions
        .sort((a, b) => b.command.length - a.command.length)
        .find(a => commandText === a.command || commandText.startsWith(a.command + " "));

      if (!action) {
        await context.reply("❌ *Error*", `Unknown command: ${commandText.split(" ")[0]}`);
        return;
      }

      const argsText = inputText.slice(action.command.length).trim();
      const args = argsText ? argsText.split(" ") : [];

      // Map command arguments to action parameters
      const params = parseCommandArgs(args, action.parameters);

      console.log("executing", action.name, params);

      try {
        const { result } = await executeActionFn(action.name, context, params, null, actionResolver, llmClient);

        if (isHtmlContent(result)) {
          const pageId = await storePage(getRootDb(), result.html, result.title);
          const baseUrl = config.html_server_base_url || `http://localhost:${config.html_server_port}`;
          const pageUrl = `${baseUrl}/page/${pageId}`;
          const linkText = result.title ? `${result.title}: ${pageUrl}` : pageUrl;
          await context.reply(linkText);
        } else if (typeof result === "string") {
          await context.reply(result);
        }
      } catch (error) {
        console.error("Error executing command:", error);
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        await context.reply("❌ *Error*", `Error: ${errorMessage}`);
      }

      return;
    }

    // Use data from message context
    const time = formatTime(messageContext.timestamp);

    // Check shouldRespond BEFORE formatting (formatting strips @mentions)
    const willRespond = shouldRespond(chatInfo, isGroup, content, selfIds, quotedSenderId);

    // Format user message text (timestamp, sender name, mention stripping)
    /** @type {string} */
    let systemPromptSuffix = "";
    if (firstBlock) {
      const formatted = formatUserMessage(firstBlock, isGroup, senderName, time, selfIds);
      firstBlock.text = formatted.formattedText;
      systemPromptSuffix = formatted.systemPromptSuffix;
    }

    // Always store the message so it's available in history for future responses
    /** @type {UserMessage} */
    const message = {role: "user", content}
    await addMessage(chatId, message, senderIds);

    const enableMemory = !!chatInfo?.memory;

    if (!willRespond) {
      return;
    }

    console.log("LLM will respond");

    // Get system prompt and model from current chat or use defaults
    let systemPrompt = (chatInfo?.system_prompt || config.system_prompt) + systemPromptSuffix;
    const chatModel = chatInfo?.model || config.model;

    // Get latest messages from DB
    const chatMessages = await getMessages(chatId)

    // Convert unsupported media types to text for non-multimodal models
    const mediaToTextModels = chatInfo?.media_to_text_models ?? {};
    const rootDb = getRootDb();
    const { messages: translatedMessages, skippedTypes } = await convertUnsupportedMedia(
      chatMessages, chatModel, mediaToTextModels, llmClient, rootDb,
    );

    if (skippedTypes.size > 0) {
      const types = [...skippedTypes].join(", ");
      await context.sendMessage(`⚠️ This model doesn't support ${types} content. The ${types} was not sent to the model. Use !config media_to_text_model to set a general media-to-text model, or image_to_text_model / audio_to_text_model / video_to_text_model for per-type models.`);
    }

    // Search long-term memory for relevant past conversations
    if (enableMemory) {
      const currentText = extractTextFromMessage(message);
      if (currentText.length >= 10) {
        try {
          const threshold = chatInfo?.memory_threshold ?? config.memory_threshold;
          const similar = await findMemories(getRootDb(), llmClient, chatId, currentText, { minSimilarity: threshold });
          if (similar.length > 0) {
            systemPrompt += "\n\n## Relevant memories\n" + formatMemoriesContext(similar);
          }
        } catch (err) {
          console.error("Memory search failed:", err);
        }
      }
    }

    // Prepare messages for OpenAI
    const formattedMessages = await formatMessagesForOpenAI(translatedMessages);

    /** @type {Session} */
    const session = {
      chatId, senderIds, context, addMessage,
    };

    /** @type {LlmConfig} */
    const llmConfig = {
      llmClient, chatModel, systemPrompt, actions,
      executeActionFn, actionResolver, actionLlmClient: llmClient,
    };

    await processLlmResponse({ session, llmConfig, formattedMessages });

    // Note: memory storage is now handled via the saveMemory tool action,
    // not automatically after each exchange.
  }

  return { handleMessage };
}

// ── Default initialization (production) ──

if (!process.env.TESTING) {
  const store = await initStore();
  const llmClient = createLlmClient();

  const { handleMessage } = createMessageHandler({
    store,
    llmClient,
    getActionsFn: getActions,
    executeActionFn: executeAction,
  });

  await startHtmlServer(config.html_server_port, getRootDb());

  const { closeWhatsapp, sendToChat } = await connectToWhatsApp(handleMessage)
    .catch(async (error) => {
      console.error("Initialization error:", error);
      await store.closeDb();
      process.exit(1);
    });

  const stopReminders = startReminderDaemon(sendToChat);
  const stopModelsCache = startModelsCacheDaemon();

  async function cleanup() {
    try {
      stopReminders();
      stopModelsCache();
      await stopHtmlServer();
      await closeWhatsapp();
      await store.closeDb();
    } catch (error) {
      console.error("Error during cleanup:", error);
    }
  }

  process.on("SIGINT", async function () {
    console.log("SIGINT received, cleaning up...");
    await cleanup();
    process.exit(0);
  });

  process.on("SIGTERM", async function () {
    console.log("SIGTERM received, cleaning up...");
    await cleanup();
    process.exit(0);
  });
  process.on("uncaughtException", async (error) => {
    console.error("Uncaught Exception:", error);
    await cleanup();
    process.exit(1);
  });
}
