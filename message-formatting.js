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
 * @param {import("./store.js").ChatRow | undefined} chatInfo
 * @param {boolean} isGroup
 * @param {IncomingContentBlock[]} content
 * @param {string[]} selfIds
 * @param {string | undefined} quotedSenderId
 * @returns {boolean}
 */
export function shouldRespond(chatInfo, isGroup, content, selfIds, quotedSenderId) {
  if (!chatInfo?.is_enabled) {
    return false;
  }

  if (!isGroup) {
    return true;
  }

  if (chatInfo.respond_on_any === true) {
    return true;
  }

  const respondOnMention = chatInfo.respond_on_mention !== false;
  const respondOnReply = chatInfo.respond_on_reply === true;

  if (!respondOnMention && !respondOnReply) {
    return false;
  }

  if (respondOnMention) {
    const isMentioned = content.some(contentPart =>
      contentPart.type === "text"
        && selfIds.some(selfId => contentPart.text.includes('@' + selfId))
    );
    if (isMentioned) {
      return true;
    }
  }

  if (respondOnReply && quotedSenderId) {
    const isReplyToBot = selfIds.includes(quotedSenderId);
    if (isReplyToBot) {
      return true;
    }
  }

  return false;
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
  const entries = Object.entries(parameters.properties);
  entries.forEach(
    ([paramName, param], i) => {
      if (i === entries.length - 1) {
        // Last parameter gets all remaining args joined
        const remaining = args.slice(i).join(" ");
        params[paramName] = remaining || param.default;
      } else {
        params[paramName] = args[i] || param.default;
      }
    },
  );
  return params;
}

/**
 * @param {ImageContentBlock} block
 * @returns {OpenAI.ChatCompletionContentPart}
 */
function formatImagePart(block) {
  return { type: "image_url", image_url: { url: `data:${block.mime_type};base64,${block.data}` } };
}

/**
 * @param {AudioContentBlock} block
 * @returns {Promise<OpenAI.ChatCompletionContentPart>}
 */
async function formatAudioPart(block) {
  /** @type {"wav" | "mp3"} */
  let format = "mp3";
  let data;
  const audioFormat = block.mime_type?.split("audio/")[1]?.split(";")[0];
  if (audioFormat === "wav" || audioFormat === "mp3") {
    format = audioFormat;
    data = block.data;
  } else {
    console.warn(`Unsupported audio format: ${block.mime_type}`);
    data = await convertAudioToMp3Base64(block.data);
  }
  return { type: "input_audio", input_audio: { data, format } };
}

/**
 * @param {QuoteContentBlock} block
 * @returns {OpenAI.ChatCompletionContentPart[]}
 */
function formatQuoteParts(block) {
  /** @type {Record<string, (b: any) => OpenAI.ChatCompletionContentPart>} */
  const quoteFormatters = {
    text: (/** @type {TextContentBlock} */ b) =>
      ({ type: "text", text: `> ${b.text.trim().replace(/\n/g, '\n> ')}` }),
    image: formatImagePart,
  };
  return block.content
    .filter(b => b.type in quoteFormatters)
    .map(b => quoteFormatters[b.type](b));
}

/** @type {Record<string, (block: any) => OpenAI.ChatCompletionContentPart | Promise<OpenAI.ChatCompletionContentPart> | OpenAI.ChatCompletionContentPart[]>} */
const contentFormatters = {
  text: (/** @type {TextContentBlock} */ block) => block,
  image: formatImagePart,
  audio: formatAudioPart,
  quote: formatQuoteParts,
};

/**
 * Format a user message's content blocks into OpenAI content parts.
 * @param {UserMessage} message
 * @returns {Promise<Array<OpenAI.ChatCompletionContentPart>>}
 */
async function formatUserContent(message) {
  /** @type {Array<OpenAI.ChatCompletionContentPart>} */
  const parts = [];

  for (const block of message.content) {
    const formatter = contentFormatters[block.type];
    if (!formatter) continue;
    const result = await formatter(block);
    if (Array.isArray(result)) {
      parts.push(...result);
    } else {
      parts.push(result);
    }
  }

  return parts;
}

/**
 * Format an assistant message into an OpenAI ChatCompletionMessageParam.
 * @param {AssistantMessage} message
 * @returns {OpenAI.ChatCompletionMessageParam}
 */
function formatAssistantContent(message) {
  /** @type {OpenAI.ChatCompletionMessageToolCall[]} */
  const toolCalls = [];
  const content = message.content
    .map(contentBlock => {
      switch (contentBlock.type) {
        case "text":
          return contentBlock;
        case "tool":
          toolCalls.push({
            type: "function",
            id: contentBlock.tool_id,
            function: {
              name: contentBlock.name,
              arguments: contentBlock.arguments,
            },
          });
      }
    })
    .filter(x => x !== undefined);

  return {
    role: "assistant",
    content,
    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}

/**
 * Format a tool message into OpenAI ChatCompletionMessageParam(s).
 * @param {ToolMessage} message
 * @returns {Array<OpenAI.ChatCompletionMessageParam>}
 */
function formatToolContent(message) {
  /** @type {Array<OpenAI.ChatCompletionMessageParam>} */
  const results = [];
  for (const contentBlock of message.content) {
    if (contentBlock.type === "text") {
      results.push({
        role: "tool",
        tool_call_id: message.tool_id,
        content: contentBlock.text,
      });
    }
  }
  return results;
}

/**
 * Convert stored Message[] rows from the DB into OpenAI ChatCompletionMessageParam[].
 * Strips leading tool results and handles user/assistant/tool roles.
 * @param {Array<{message_data: Message, sender_id: string}>} chatMessages - Rows from DB (newest first)
 * @returns {Promise<Array<OpenAI.ChatCompletionMessageParam>>}
 */
export async function formatMessagesForOpenAI(chatMessages) {
  /** @type {Array<OpenAI.ChatCompletionMessageParam>} */
  const formatted = [];
  const reversedMessages = [...chatMessages].reverse();

  // remove starting tool results from the messages
  while (reversedMessages[0]?.message_data?.role === "tool") {
    reversedMessages.shift();
  }

  for (const msg of reversedMessages) {
    switch (msg.message_data?.role) {
      case "user":
        formatted.push({
          role: "user",
          name: msg.sender_id,
          content: await formatUserContent(msg.message_data),
        });
        break;
      case "assistant":
        formatted.push(formatAssistantContent(msg.message_data));
        break;
      case "tool":
        formatted.push(...formatToolContent(msg.message_data));
        break;
    }
  }

  return formatted;
}
