/**
 * WhatsApp LLM Bot with JavaScript execution capabilities
 */

import OpenAI from "openai";
import { getActions, executeAction } from "./actions.js";
import config from "./config.js";
import { createLlmClient } from "./llm.js";
import { shortenToolId } from "./utils.js";
import { connectToWhatsApp } from "./whatsapp-adapter.js";
import { initStore } from "./store.js";
import {
  actionsToOpenAIFormat,
  shouldRespond,
  formatUserMessage,
  parseCommandArgs,
  formatMessagesForOpenAI,
} from "./message-formatting.js";

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
    const { chatId, senderIds, content, isGroup, senderName, selfIds } = messageContext;

    console.log("INCOMING MESSAGE:", JSON.stringify(messageContext, null, 2));

    // Create legacy context for actions (maintains backward compatibility)
    /** @type {Context} */
    const context = {
      chatId: chatId,
      senderIds,
      content: content,
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
    };

    // Load actions
    /** @type {Action[]} */
    const actions = await getActionsFn();

    const firstBlock = content.find(block=>block.type === "text")

    if (firstBlock?.text?.startsWith("!")) {
      const [rawCommand, ...args] = firstBlock.text.slice(1).trim().split(" ");
      const command = rawCommand.toLowerCase();

      const action = actions.find(action => action.command === command);

      if (!action) {
        await context.reply("❌ *Error*", `Unknown command: ${command}`);
        return;
      }

      // Map command arguments to action parameters
      const params = parseCommandArgs(args, action.parameters);

      console.log("executing", action.name, params);

      try {
        const { result } = await executeActionFn(action.name, context, params);

        if (typeof result === "string") {
          await context.reply(`⚡ *Command* !${command}`, result);
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

    // Insert chatId into DB if not already present
    await createChat(chatId);

    // Check if the bot should respond
    const chatInfoForRespond = await getChat(chatId);
    if (!shouldRespond(chatInfoForRespond, isGroup, content, selfIds)) {
      return;
    }

    console.log("LLM will respond");

    // Get system prompt and model from current chat or use defaults
    const chatInfo = await getChat(chatId);
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

    // Prepare messages for OpenAI
    const chatMessages_formatted = formatMessagesForOpenAI(chatMessages);

    async function processLlmResponse() {

      let response;
      try {
        response = await llmClient.chat.completions.create({
          model: chatModel,
          messages: [
            { role: "system", content: systemPrompt },
            ...chatMessages_formatted,
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

      // Add assistant message to conversation context
      /** @type {AssistantMessage} */
      const assistantMessage = {
        role: "assistant",
        content: [],
      };

      if (responseMessage.content) {
        console.log("RESPONSE SENT:", responseMessage.content);
        await context.reply("🤖 *AI Assistant*", responseMessage.content);
        assistantMessage.content.push({
          type: "text",
          text: responseMessage.content,
        });
      }


      if (responseMessage.tool_calls) {
        // Add tool calls to assistant message
        for (const toolCall of responseMessage.tool_calls) {
          assistantMessage.content.push({
            type: "tool",
            tool_id: toolCall.id,
            name: toolCall.function.name,
            arguments: toolCall.function.arguments
          })

          // Show tool call to user
          const shortId = shortenToolId(toolCall.id);
          const args = JSON.parse(toolCall.function.arguments);
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

        // Store tool calls in database
        await addMessage(chatId, assistantMessage, senderIds)

        // Add assistant message with tool calls to conversation context
        chatMessages_formatted.push(responseMessage);

        let continueProcessing = false;

        for (const toolCall of responseMessage.tool_calls) {
          const toolName = toolCall.function.name;
          const toolArgs = JSON.parse(toolCall.function.arguments);
          const shortId = shortenToolId(toolCall.id);
          console.log("executing", toolName, toolArgs);

          try {
            const functionResponse = await executeActionFn(
              toolName,
              context,
              toolArgs,
              toolCall.id,
            );
            console.log("response", functionResponse);

            if (toolName !== "new_conversation") {
              // Store tool result in database
              /** @type {ToolMessage} */
              const toolMessage = {
                role: "tool",
                tool_id: toolCall.id,
                content: [{type: "text", text: JSON.stringify(functionResponse.result)}]
              }
              await addMessage(chatId, toolMessage, senderIds)
            }

            const resultMessage =
              typeof functionResponse.result === "string"
                ? functionResponse.result
                : JSON.stringify(functionResponse.result, null, 2);
            // Show tool result to user
            await context.sendMessage(
              `✅ *Result*    [${shortId}]`,
              resultMessage,
            );

            if (functionResponse.permissions.autoContinue) {
              // If the tool result indicates to continue processing, set flag
              continueProcessing = true;
            }

            // Add tool result to conversation context
            /** @type {OpenAI.ChatCompletionMessageParam} */
            const toolResultMessage = {
              role: "tool",
              tool_call_id: toolCall.id,
              content: resultMessage,
            };
            chatMessages_formatted.push(toolResultMessage);

          } catch (error) {
            console.error("Error executing tool:", error);
            const errorMessage = `Error executing ${toolName}: ${error instanceof Error ? error.message : String(error)}`;
            // Store error as tool result
            /** @type {ToolMessage} */
            const toolError = {
              role: "tool",
              tool_id: toolCall.id,
              content: [{type: "text", text: errorMessage}],
            }
            await addMessage(chatId, toolError, senderIds)

            // Show tool error to user
            await context.sendMessage(
              `❌ *Tool Error*    [${shortId}]`,
              errorMessage,
            );

            // Continue processing to selffix the error
            continueProcessing = true;

            // Add tool error to conversation context
            /** @type {OpenAI.ChatCompletionMessageParam} */
            const toolResultMessage = {
              role: "tool",
              tool_call_id: toolCall.id,
              content: errorMessage,
            };
            chatMessages_formatted.push(toolResultMessage);
          }

        }

        // Recursively process LLM response after tool execution
        if (continueProcessing) {
          await processLlmResponse();
        }
      } else {
        // Only add assistant message if no tool calls (to avoid duplicates)
        chatMessages_formatted.push(responseMessage);
        await addMessage(chatId, assistantMessage, senderIds);
      }
    }

    await processLlmResponse();
  }

  return { handleMessage };
}

// ── Default initialization (production) ──

const store = await initStore();
const llmClient = createLlmClient();

const { handleMessage } = createMessageHandler({
  store,
  llmClient,
  getActionsFn: getActions,
  executeActionFn: executeAction,
});

export { handleMessage };

async function setup () {
  // Initialize everything
  const { closeWhatsapp } = await connectToWhatsApp(handleMessage)
    .catch(async (error) => {
      console.error("Initialization error:", error);
      await store.closeDb();
      process.exit(1);
    })


  async function cleanup() {
    try {
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

if (!process.env.TESTING) await setup()
