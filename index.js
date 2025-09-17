/**
 * WhatsApp LLM Bot with JavaScript execution capabilities
 */

import OpenAI from "openai";
import { getActions, executeAction } from "./actions.js";
import config from "./config.js";
import { shortenToolId } from "./utils.js";
import { connectToWhatsApp } from "./whatsapp-adapter.js";
import { initStore } from "./store.js";
import { convertAudioToMp3Base64 } from "./audio_conversion.js";

const { addMessage, closeDb, createChat, getChat, getMessages } = await initStore();

/**
 * Convert actions to OpenAI tools format
 * @param {Action[]} actions
 * @returns {OpenAI.Chat.Completions.ChatCompletionTool[]}
 */
function actionsToOpenAIFormat(actions) {
  return actions.map((action) => ({
    type: "function",
    function: {
      name: action.name,
      description: action.description,
      parameters: action.parameters,
    },
  }));
}

/**
 * Handle incoming WhatsApp messages
 * @param {IncomingContext} messageContext
 * @returns {Promise<void>}
 */
export async function handleMessage(messageContext) {
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
      const fullMessage = `${header}\n\n${text}`;
      await messageContext.sendMessage(fullMessage);
    },
    reply: async (header, text) => {
      const fullMessage = `${header}\n\n${text}`;
      await messageContext.replyToMessage(fullMessage);
    },
  };

  // Load actions
  /** @type {Action[]} */
  const actions = await getActions();

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
    /** @type {{[paramName: string]: string}} */
    const params = {};
    Object.entries(action.parameters.properties).forEach(
      ([paramName, param], i) => {
        params[paramName] = args[i] || param.default;
      },
    );

    console.log("executing", action.name, params);

    try {
      const { result } = await executeAction(action.name, context, params);

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

  /**
   * Check if the bot should respond to a message
   */
  shouldRespond: {
    // Skip if chat is not enabled
    const chatInfo = await getChat(chatId);
    if (!chatInfo?.is_enabled) {
      return;
    }

    // Respond if in a private chat
    if (!isGroup) {
      break shouldRespond;
    }

    // Respond in groups if I have been mentioned
    const isMentioned = content.some(contentPart =>
      contentPart.type === "text"
        && selfIds.some(selfId => contentPart.text.includes('@' + selfId))
    );
    console.log({isMentioned, content});
    if (isMentioned) {
      break shouldRespond;
    }

    return;
  }

  console.log("LLM will respond");

  // Get system prompt from current chat or use default
  const chatInfo = await getChat(chatId);
  let systemPrompt = chatInfo?.system_prompt || config.system_prompt;

  if (firstBlock) {
    let messageBody_formatted;
    if (isGroup) {

      // Remove mention of self from start of message
      const mentionPattern = new RegExp(`^@(${messageContext.selfIds.join("|")}) *`, "g");
      const cleanedContent = firstBlock.text.replace(mentionPattern, "");

      // TODO: Implement mention replacement using mentions
      messageBody_formatted = `[${time}] ${senderName}: ${cleanedContent}`;
      // TODO: Get group chat name from high-level API
      systemPrompt += `\n\nYou are in a group chat`;
    } else {
      messageBody_formatted = `[${time}] ${firstBlock.text}`;
    }
    firstBlock.text = messageBody_formatted;
  }

  /** @type {UserMessage} */
  const message = {role: "user", content}

  // Insert message into DB
  await addMessage(chatId, message, senderIds);

  // Get latest messages from DB
  const chatMessages = await getMessages(chatId)

  // Prepare messages for OpenAI (reconstruct proper format with tool calls)
  /** @type {Array<OpenAI.ChatCompletionMessageParam>} */
  const chatMessages_formatted = [];
  const reversedMessages = chatMessages.reverse();

  // remove starting tool results from the messages
  while (reversedMessages[0]?.message_data?.role === "tool") {
    reversedMessages.shift();
  }

  for (const msg of reversedMessages) {
    switch (msg.message_data?.role) {
      case "user":
        /** @type {Array<OpenAI.ChatCompletionContentPart>} */
        const messageContent = []
        for (const contentBlock of msg.message_data.content) {
          switch (contentBlock.type) {
            case "quote":
              for (const quoteBlock of contentBlock.content) {
                switch (quoteBlock.type) {
                  case "text":
                    messageContent.push({ type: "text", text: `> ${quoteBlock.text.trim().replace(/\n/g, '\n> ')}` });
                    break;
                  case "image":
                    const dataUrl = `data:${quoteBlock.mime_type};base64,${quoteBlock.data}`;
                    messageContent.push({ type: "image_url", image_url: { url: dataUrl } });
                    break;
                }
              }
              break;
            case "text":
              messageContent.push(contentBlock);
              break;
            case "image":
              const dataUrl = `data:${contentBlock.mime_type};base64,${contentBlock.data}`;
              messageContent.push({ type: "image_url", image_url: { url: dataUrl } });
              break;
            case "audio":
              let format = contentBlock.mime_type?.split("audio/")[1].split(";")[0];
              let data;
              if (format !== "wav" && format !== "mp3") {
                console.warn(`Unsupported audio format: ${contentBlock.mime_type}`);
                data = convertAudioToMp3Base64(contentBlock.data);
                format = "mp3";
              } else {
                data = contentBlock.data;
              }
              messageContent.push({
                type: "input_audio",
                input_audio: {
                  data: data,
                  // @ts-ignore
                  format: format
                }
              });
              break;
          }
        };
        chatMessages_formatted.push({
          role: "user",
          name: msg.sender_id,
          content: messageContent,
        });
        break;
      case "assistant":
        /** @type {OpenAI.ChatCompletionMessageToolCall[]} */
        const toolCalls = [];
        chatMessages_formatted.push({
          role: "assistant",
          content: msg.message_data.content.map( contentBlock => {
            switch (contentBlock.type) {
              case "text":
                return contentBlock;
              case "tool":
                toolCalls.push({
                  type: "function",
                  id: contentBlock.tool_id,
                  function: {
                    name: contentBlock.name,
                    arguments: contentBlock.arguments
                  }
                });
            }
          }).filter(x=>!!x),
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        });
        break;
      case "tool":
      for (const contentBlock of msg.message_data.content) {
          switch (contentBlock.type) {
            case "text":
              chatMessages_formatted.push({
                role: "tool",
                tool_call_id: msg.message_data.tool_id,
                content: contentBlock.text,
              });
              break;
          }
        }
        break;
      // Optionally handle unknown types
      default:
        // Ignore or log unknown message types
        break;
    }
  }

  // Initialize LLM client
  const llmClient = new OpenAI({
    apiKey: config.llm_api_key,
    baseURL: config.base_url,
  });

  async function processLlmResponse() {

    let response;
    try {
      response = await llmClient.chat.completions.create({
        model: config.model,
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
      // await db.sql`INSERT INTO messages(chat_id, message, content, sender_id, message_type) VALUES (${chatId}, ${responseMessage.content}, ${JSON.stringify(responseMessage.content)}, ${messageContext.selfId}, 'assistant')`;
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
        await context.sendMessage(
          `🔧 *Executing* ${toolCall.function.name}    [${shortId}]`,
          `parameters:\n\`\`\`\n${JSON.stringify(JSON.parse(toolCall.function.arguments), null, 2)}\n\`\`\``,
        );
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
          const functionResponse = await executeAction(
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
          // await db.sql`INSERT INTO messages(chat_id, message, content, sender_id, message_type, tool_call_id) VALUES (${chatId}, ${errorMessage}, ${JSON.stringify(errorMessage)}, ${messageContext.selfId}, 'tool_result', ${toolCall.id})`;
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

async function setup () {
  // Initialize everything
  const { closeWhatsapp } = await connectToWhatsApp(handleMessage)
    .catch(async (error) => {
      console.error("Initialization error:", error);
      await closeDb();
      process.exit(1);
    })


  async function cleanup() {
    try {
      await closeWhatsapp();
      await closeDb();
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

await setup()
