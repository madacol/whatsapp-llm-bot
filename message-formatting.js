/**
 * Pure functions extracted from index.js for testability.
 */

import OpenAI from "openai";
import { convertAudioToMp3Base64 } from "./audio_conversion.js";

/**
 * Convert actions to OpenAI tools format
 * @param {Action[]} actions
 * @returns {OpenAI.Chat.Completions.ChatCompletionTool[]}
 */
export function actionsToOpenAIFormat(actions) {
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
 * Decide whether the bot should respond to a message.
 * @param {{ is_enabled?: boolean } | undefined} chatInfo
 * @param {boolean} isGroup
 * @param {IncomingContentBlock[]} content
 * @param {string[]} selfIds
 * @returns {boolean}
 */
export function shouldRespond(chatInfo, isGroup, content, selfIds) {
  if (!chatInfo?.is_enabled) {
    return false;
  }

  // Respond in private chats
  if (!isGroup) {
    return true;
  }

  // Respond in groups only if mentioned
  const isMentioned = content.some(contentPart =>
    contentPart.type === "text"
      && selfIds.some(selfId => contentPart.text.includes('@' + selfId))
  );
  console.log({isMentioned, content});
  return isMentioned;
}

/**
 * Format a user message with timestamp and (for groups) sender name + mention stripping.
 * Returns the formatted text and an optional system prompt suffix.
 * @param {TextContentBlock} firstBlock
 * @param {boolean} isGroup
 * @param {string} senderName
 * @param {string} time
 * @param {string[]} selfIds
 * @returns {{ formattedText: string, systemPromptSuffix: string }}
 */
export function formatUserMessage(firstBlock, isGroup, senderName, time, selfIds) {
  let formattedText;
  let systemPromptSuffix = "";

  if (isGroup) {
    // Remove mention of self from start of message
    const mentionPattern = new RegExp(`^@(${selfIds.join("|")}) *`, "g");
    const cleanedContent = firstBlock.text.replace(mentionPattern, "");
    formattedText = `[${time}] ${senderName}: ${cleanedContent}`;
    systemPromptSuffix = `\n\nYou are in a group chat`;
  } else {
    formattedText = `[${time}] ${firstBlock.text}`;
  }

  return { formattedText, systemPromptSuffix };
}

/**
 * Parse `!command arg1 arg2` into `{ paramName: value }` based on action parameter schema.
 * @param {string[]} args - The arguments after the command name
 * @param {Action['parameters']} parameters - The action's JSON Schema parameters
 * @returns {{[paramName: string]: string}}
 */
export function parseCommandArgs(args, parameters) {
  /** @type {{[paramName: string]: string}} */
  const params = {};
  Object.entries(parameters.properties).forEach(
    ([paramName, param], i) => {
      params[paramName] = args[i] || param.default;
    },
  );
  return params;
}

/**
 * Convert stored Message[] rows from the DB into OpenAI ChatCompletionMessageParam[].
 * Strips leading tool results and handles user/assistant/tool roles.
 * @param {Array<{message_data: Message, sender_id: string}>} chatMessages - Rows from DB (newest first)
 * @returns {Array<OpenAI.ChatCompletionMessageParam>}
 */
export function formatMessagesForOpenAI(chatMessages) {
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

  return chatMessages_formatted;
}
