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
 * @returns {number} The assigned media ID
 */
function tagMedia(parts, registry, originalBlock) {
  const id = registry.size + 1;
  registry.set(id, originalBlock);
  parts.push({ type: "text", text: `[media:${id}]` });
  return id;
}

/**
 * Register a media block in the registry without appending to an OpenAI parts array.
 * @param {MediaRegistry} registry
 * @param {IncomingContentBlock} block
 * @returns {number} The assigned media ID
 */
export function registerMedia(registry, block) {
  const id = registry.size + 1;
  registry.set(id, block);
  return id;
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
 * Normalize tool message ordering so each tool result immediately follows its
 * assistant message, orphaned tool results are dropped, and missing tool results
 * get placeholders. This prevents 400 errors from the LLM API which requires
 * tool_result blocks to follow the assistant message that issued the tool_calls.
 * @param {Array<OpenAI.ChatCompletionMessageParam>} messages
 * @returns {Array<OpenAI.ChatCompletionMessageParam>}
 */
function removeOrphanedToolResults(messages) {
  // Map each tool_call_id → index of the assistant message that owns it
  /** @type {Map<string, number>} */
  const toolCallOwner = new Map();

  // Track which tool_call_ids each assistant message expects
  /** @type {Map<number, string[]>} */
  const assistantToolCallIds = new Map();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "assistant" && "tool_calls" in msg && msg.tool_calls) {
      const ids = msg.tool_calls.map(tc => tc.id);
      assistantToolCallIds.set(i, ids);
      for (const id of ids) {
        toolCallOwner.set(id, i);
      }
    }
  }

  // Group tool result messages by their owning assistant index
  /** @type {Map<number, OpenAI.ChatCompletionMessageParam[]>} */
  const toolResultsByAssistant = new Map();

  // Collect non-tool messages in order, excluding tool results (we'll re-insert them)
  /** @type {Array<{ msg: OpenAI.ChatCompletionMessageParam, originalIndex: number }>} */
  const nonToolMessages = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "tool") {
      const toolMsg = /** @type {OpenAI.ChatCompletionToolMessageParam} */ (msg);
      const ownerIdx = toolCallOwner.get(toolMsg.tool_call_id);
      if (ownerIdx !== undefined) {
        if (!toolResultsByAssistant.has(ownerIdx)) {
          toolResultsByAssistant.set(ownerIdx, []);
        }
        toolResultsByAssistant.get(ownerIdx).push(msg);
      }
      // Orphaned tool results (no ownerIdx) are silently dropped
    } else {
      nonToolMessages.push({ msg, originalIndex: i });
    }
  }

  // Rebuild: for each non-tool message, emit it; after each assistant with
  // tool_calls, insert its grouped tool results + placeholders for missing ones
  /** @type {Array<OpenAI.ChatCompletionMessageParam>} */
  const result = [];

  for (const { msg, originalIndex } of nonToolMessages) {
    result.push(msg);

    if (assistantToolCallIds.has(originalIndex)) {
      const expectedIds = assistantToolCallIds.get(originalIndex);
      const actualResults = toolResultsByAssistant.get(originalIndex) ?? [];

      /** @type {Set<string>} */
      const receivedIds = new Set(
        actualResults.map(m =>
          /** @type {OpenAI.ChatCompletionToolMessageParam} */ (m).tool_call_id
        )
      );

      // Emit actual results in their expected order
      for (const id of expectedIds) {
        const existing = actualResults.find(
          m => /** @type {OpenAI.ChatCompletionToolMessageParam} */ (m).tool_call_id === id
        );
        if (existing) {
          result.push(existing);
        } else {
          // Placeholder for missing tool result
          result.push({
            role: /** @type {const} */ ("tool"),
            tool_call_id: id,
            content: "[tool result unavailable]",
          });
        }
      }
    }
  }

  return result;
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
