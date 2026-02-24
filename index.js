/**
 * WhatsApp LLM Bot with JavaScript execution capabilities
 */

import OpenAI from "openai";
import { getActions, executeAction, getChatActions, getChatAction, getAction } from "./actions.js";
import config from "./config.js";
import { createLlmClient } from "./llm.js";
import { shortenToolId } from "./utils.js";
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
import { translateUnsupportedContent, ensureTranslationSchema } from "./content-translator.js";
import { getDb } from "./db.js";

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
 */
async function displayToolCall(toolCall, context) {
  if (!context.isDebug) {
    await context.sendMessage(`🔧 ${toolCall.function.name}`);
    return;
  }

  const shortId = shortenToolId(toolCall.id);
  let args;
  try {
    args = JSON.parse(toolCall.function.arguments || "{}");
  } catch {
    console.error("Failed to parse tool call arguments:", toolCall.function.arguments);
    args = {};
  }
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
    if (resultMessage.length > 200) {
      const remaining = resultMessage.length - 200;
      const remainingLines = resultMessage.slice(200).split("\n").length - 1;
      const suffix = remainingLines > 0
        ? `… +${remaining} chars, ${remainingLines} lines`
        : `… +${remaining} chars`;
      await context.sendMessage(`✅ ${resultMessage.slice(0, 200)}${suffix}`);
    } else {
      await context.sendMessage(`✅ ${resultMessage}`);
    }
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
 * Execute a single tool call: run action, store result, display to user.
 * Returns whether processing should continue (autoContinue or error).
 * @param {{
 *   toolCall: OpenAI.Chat.Completions.ChatCompletionMessageToolCall,
 *   context: Context,
 *   executeActionFn: typeof executeAction,
 *   addMessage: Store['addMessage'],
 *   chatId: string,
 *   senderIds: string[],
 *   formattedMessages: Array<OpenAI.ChatCompletionMessageParam>,
 *   actionResolver?: (name: string) => Promise<AppAction | null>,
 *   actionLlmClient?: import("openai").default,
 * }} params
 * @returns {Promise<boolean>} Whether to continue processing (loop again)
 */
async function executeAndStoreTool({
  toolCall, context, executeActionFn, addMessage,
  chatId, senderIds, formattedMessages, actionResolver, actionLlmClient,
}) {
  const toolName = toolCall.function.name;
  const toolArgs = parseToolArgs(toolCall.function.arguments);
  const shortId = shortenToolId(toolCall.id);
  console.log("executing", toolName, toolArgs);

  try {
    const functionResponse = await executeActionFn(
      toolName, context, toolArgs, toolCall.id, actionResolver, actionLlmClient,
    );
    console.log("response", functionResponse);

    // Store tool result (silent tools get a stub to satisfy API pairing)
    /** @type {ToolMessage} */
    const toolMessage = {
      role: "tool",
      tool_id: toolCall.id,
      content: [{type: "text", text: functionResponse.permissions.silent
        ? "[recalled prior messages]"
        : JSON.stringify(functionResponse.result)}],
    };
    await addMessage(chatId, toolMessage, senderIds);

    const resultMessage =
      typeof functionResponse.result === "string"
        ? functionResponse.result
        : JSON.stringify(functionResponse.result, null, 2);

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
 *   llmClient: OpenAI,
 *   chatModel: string,
 *   systemPrompt: string,
 *   actions: Action[],
 *   formattedMessages: Array<OpenAI.ChatCompletionMessageParam>,
 *   context: Context,
 *   executeActionFn: typeof executeAction,
 *   addMessage: Store['addMessage'],
 *   chatId: string,
 *   senderIds: string[],
 *   actionResolver?: (name: string) => Promise<AppAction | null>,
 *   actionLlmClient?: import("openai").default,
 * }} params
 */
async function processLlmResponse({
  llmClient, chatModel, systemPrompt, actions,
  formattedMessages, context, executeActionFn, addMessage,
  chatId, senderIds, actionResolver, actionLlmClient,
}) {
  let depth = 0;

  while (depth <= MAX_TOOL_CALL_DEPTH) {
    if (depth === MAX_TOOL_CALL_DEPTH) {
      await context.reply(
        "⚠️ *Depth limit*",
        `Reached maximum tool call depth (${MAX_TOOL_CALL_DEPTH}). Stopping.`,
      );
      return;
    }

    let response;
    try {
      response = await llmClient.chat.completions.create({
        model: chatModel,
        messages: [
          { role: "system", content: systemPrompt },
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
      await addMessage(chatId, assistantMessage, senderIds);
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
      await displayToolCall(toolCall, context);
    }

    await addMessage(chatId, assistantMessage, senderIds);
    formattedMessages.push(responseMessage);

    // Execute each tool call
    let continueProcessing = false;
    for (const toolCall of responseMessage.tool_calls) {
      const shouldContinue = await executeAndStoreTool({
        toolCall, context, executeActionFn, addMessage,
        chatId, senderIds, formattedMessages, actionResolver, actionLlmClient,
      });
      if (shouldContinue) continueProcessing = true;
    }

    if (!continueProcessing) return;
    depth++;
  }
}

/**
 * @typedef {{
 *   addMessage: Awaited<ReturnType<typeof initStore>>['addMessage'],
 *   closeDb: Awaited<ReturnType<typeof initStore>>['closeDb'],
 *   createChat: Awaited<ReturnType<typeof initStore>>['createChat'],
 *   getChat: Awaited<ReturnType<typeof initStore>>['getChat'],
 *   getMessages: Awaited<ReturnType<typeof initStore>>['getMessages'],
 * }} Store
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
      confirm: messageContext.confirm,
    };

    // Load actions (global + chat-scoped)
    const globalActions = await getActionsFn();
    const chatActions = await getChatActions(chatId);
    /** @type {Action[]} */
    const actions = [...globalActions, ...chatActions];

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

        if (typeof result === "string") {
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
    const time = messageContext.timestamp.toLocaleString("en-EN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });

    if (!shouldRespond(chatInfo, isGroup, content, selfIds, quotedSenderId)) {
      return;
    }

    console.log("LLM will respond");

    // Get system prompt and model from current chat or use defaults
    let systemPrompt = chatInfo?.system_prompt || config.system_prompt;
    const chatModel = chatInfo?.model || config.model;

    if (firstBlock) {
      const { formattedText, systemPromptSuffix } = formatUserMessage(firstBlock, isGroup, senderName, time, selfIds);
      firstBlock.text = formattedText;
      systemPrompt += systemPromptSuffix;
    }

    /** @type {UserMessage} */
    const message = {role: "user", content}

    // Insert message into DB
    await addMessage(chatId, message, senderIds);

    // Get latest messages from DB
    const chatMessages = await getMessages(chatId)

    // Translate unsupported content types for non-multimodal models
    const contentModels = chatInfo?.content_models ?? {};
    const rootDb = getDb("./pgdata/root");
    const translatedMessages = await translateUnsupportedContent(
      chatMessages, chatModel, contentModels, llmClient, rootDb,
    );

    // Prepare messages for OpenAI
    const formattedMessages = await formatMessagesForOpenAI(translatedMessages);

    await processLlmResponse({
      llmClient, chatModel, systemPrompt, actions,
      formattedMessages, context, executeActionFn, addMessage,
      chatId, senderIds, actionResolver, actionLlmClient: llmClient,
    });
  }

  return { handleMessage };
}

// ── Default initialization (production) ──

if (!process.env.TESTING) {
  const store = await initStore();
  await ensureTranslationSchema(getDb("./pgdata/root"));
  const llmClient = createLlmClient();

  const { handleMessage } = createMessageHandler({
    store,
    llmClient,
    getActionsFn: getActions,
    executeActionFn: executeAction,
  });

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
