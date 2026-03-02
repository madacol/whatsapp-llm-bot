/**
 * Pure functions extracted from index.js for testability.
 */

import OpenAI from "openai";
import { convertAudioToMp3Base64 } from "./audio_conversion.js";
import { createLogger } from "./logger.js";

const log = createLogger("message-formatting");

/**
 * Convert actions to OpenAI tools format.
 * When `hasMedia` is true, injects an optional `_media_refs` parameter
 * so the LLM can reference tagged media from the conversation.
 * @param {Action[]} actions
 * @param {boolean} [hasMedia]
 * @returns {OpenAI.Chat.Completions.ChatCompletionTool[]}
 */
export function actionsToOpenAIFormat(actions, hasMedia) {
  return actions.map((action) => {
    const parameters = hasMedia
      ? {
          ...action.parameters,
          properties: {
            ...action.parameters.properties,
            _media_refs: {
              type: "array",
              items: { type: "integer" },
              description: "Optional [media:N] IDs from conversation to include as input",
            },
          },
        }
      : action.parameters;

    return {
      type: "function",
      function: {
        name: action.name,
        description: action.description,
        parameters,
      },
    };
  });
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

  const mode = chatInfo.respond_on ?? "mention";

  if (mode === "any") {
    return true;
  }

  const isMentioned = content.some(contentPart =>
    contentPart.type === "text"
      && selfIds.some(selfId => contentPart.text.includes('@' + selfId))
  );
  if (isMentioned) {
    return true;
  }

  if (mode === "mention+reply" && quotedSenderId) {
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
 * Tag a media block in the registry and append a `[media:N]` text marker.
 * @param {Array<OpenAI.ChatCompletionContentPart>} parts
 * @param {MediaRegistry} registry
 * @param {IncomingContentBlock} originalBlock
 */
function tagMedia(parts, registry, originalBlock) {
  const id = registry.size + 1;
  registry.set(id, originalBlock);
  parts.push({ type: "text", text: `[media:${id}]` });
}

/**
 * Format a user message's content blocks into OpenAI content parts.
 * Media blocks are tagged with `[media:N]` and registered in the registry.
 * @param {UserMessage} message
 * @param {MediaRegistry} registry
 * @returns {Promise<Array<OpenAI.ChatCompletionContentPart>>}
 */
async function formatUserContent(message, registry) {
  /** @type {Array<OpenAI.ChatCompletionContentPart>} */
  const parts = [];

  for (const contentBlock of message.content) {
    switch (contentBlock.type) {
      case "quote": {
        for (const quoteBlock of contentBlock.content) {
          switch (quoteBlock.type) {
            case "text":
              parts.push({ type: "text", text: `> ${quoteBlock.text.trim().replace(/\n/g, '\n> ')}` });
              break;
            case "image": {
              const dataUrl = `data:${quoteBlock.mime_type};base64,${quoteBlock.data}`;
              parts.push({ type: "image_url", image_url: { url: dataUrl } });
              tagMedia(parts, registry, quoteBlock);
              break;
            }
          }
        }
        break;
      }
      case "text":
        parts.push(contentBlock);
        break;
      case "image": {
        const dataUrl = `data:${contentBlock.mime_type};base64,${contentBlock.data}`;
        parts.push({ type: "image_url", image_url: { url: dataUrl } });
        tagMedia(parts, registry, contentBlock);
        break;
      }
      case "audio": {
        /** @type {"wav" | "mp3"} */
        let format = "mp3";
        let data;
        const audioFormat = contentBlock.mime_type?.split("audio/")[1]?.split(";")[0];
        if (audioFormat === "wav" || audioFormat === "mp3") {
          format = audioFormat;
          data = contentBlock.data;
        } else {
          log.warn(`Unsupported audio format: ${contentBlock.mime_type}`);
          data = await convertAudioToMp3Base64(contentBlock.data);
        }
        parts.push({
          type: "input_audio",
          input_audio: { data, format },
        });
        tagMedia(parts, registry, contentBlock);
        break;
      }
      case "video": {
        const videoUrl = `data:${contentBlock.mime_type};base64,${contentBlock.data}`;
        parts.push(/** @type {*} */ ({
          type: "video_url",
          video_url: { url: videoUrl },
        }));
        tagMedia(parts, registry, contentBlock);
        break;
      }
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
 * Media blocks are tagged with `[media:N]` and registered in the registry.
 * @param {ToolMessage} message
 * @param {MediaRegistry} registry
 * @returns {Array<OpenAI.ChatCompletionMessageParam>}
 */
function formatToolContent(message, registry) {
  const hasMedia = message.content.some((b) => b.type === "image" || b.type === "video");

  if (!hasMedia) {
    /** @type {Array<OpenAI.ChatCompletionMessageParam>} */
    const results = [];
    for (const block of message.content) {
      if (block.type === "text") {
        results.push({
          role: /** @type {const} */ ("tool"),
          tool_call_id: message.tool_id,
          content: block.text,
        });
      }
    }
    return results;
  }

  // Multipart: combine text + images/video into a single tool message
  /** @type {Array<OpenAI.ChatCompletionContentPart>} */
  const parts = [];
  for (const block of message.content) {
    if (block.type === "text") {
      parts.push({ type: /** @type {const} */ ("text"), text: block.text });
    } else if (block.type === "image") {
      parts.push({
        type: /** @type {const} */ ("image_url"),
        image_url: { url: `data:${block.mime_type};base64,${block.data}` },
      });
      tagMedia(parts, registry, block);
    } else if (block.type === "video") {
      parts.push(/** @type {*} */ ({
        type: "video_url",
        video_url: { url: `data:${block.mime_type};base64,${block.data}` },
      }));
      tagMedia(parts, registry, block);
    }
  }
  // OpenAI's types restrict tool content to text-only, but the API accepts image_url parts
  return [/** @type {OpenAI.ChatCompletionMessageParam} */ (
    { role: "tool", tool_call_id: message.tool_id, content: parts }
  )];
}

/**
 * Remove tool result messages whose tool_call_id has no matching tool_calls entry
 * in any assistant message. This prevents 400 errors from the LLM API when
 * conversation history contains orphaned tool results (e.g. after truncation).
 * @param {Array<OpenAI.ChatCompletionMessageParam>} messages
 * @returns {Array<OpenAI.ChatCompletionMessageParam>}
 */
function removeOrphanedToolResults(messages) {
  /** @type {Set<string>} */
  const validToolCallIds = new Set();

  for (const msg of messages) {
    if (msg.role === "assistant" && "tool_calls" in msg && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        validToolCallIds.add(tc.id);
      }
    }
  }

  return messages.filter(msg => {
    if (msg.role !== "tool") return true;
    const toolMsg = /** @type {OpenAI.ChatCompletionToolMessageParam} */ (msg);
    return validToolCallIds.has(toolMsg.tool_call_id);
  });
}

/**
 * Convert stored Message[] rows from the DB into OpenAI ChatCompletionMessageParam[].
 * Removes orphaned tool results and handles user/assistant/tool roles.
 * Media blocks are tagged with `[media:N]` markers and collected in a registry.
 * @param {Array<{message_data: Message, sender_id: string}>} chatMessages - Rows from DB (newest first)
 * @returns {Promise<{messages: Array<OpenAI.ChatCompletionMessageParam>, mediaRegistry: MediaRegistry}>}
 */
export async function formatMessagesForOpenAI(chatMessages) {
  /** @type {Array<OpenAI.ChatCompletionMessageParam>} */
  const formatted = [];
  /** @type {MediaRegistry} */
  const mediaRegistry = new Map();
  const reversedMessages = [...chatMessages].reverse();

  for (const msg of reversedMessages) {
    switch (msg.message_data?.role) {
      case "user":
        formatted.push({
          role: "user",
          name: msg.sender_id,
          content: await formatUserContent(msg.message_data, mediaRegistry),
        });
        break;
      case "assistant":
        formatted.push(formatAssistantContent(msg.message_data));
        break;
      case "tool":
        formatted.push(...formatToolContent(msg.message_data, mediaRegistry));
        break;
    }
  }

  return { messages: removeOrphanedToolResults(formatted), mediaRegistry };
}
