/**
 * Pure functions extracted from index.js for testability.
 */

/**
 * Convert actions to tool definitions format.
 * When `hasMedia` is true, injects an optional `_media_refs` parameter
 * so the LLM can reference tagged media from the conversation.
 * @param {Action[]} actions
 * @param {boolean} [hasMedia]
 * @returns {ToolDefinition[]}
 */
export function actionsToToolDefinitions(actions, hasMedia) {
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
      type: /** @type {const} */ ("function"),
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
 * Check whether a content block is a media type (image, video, or audio).
 * @param {IncomingContentBlock | ToolContentBlock} block
 * @returns {block is ImageContentBlock | VideoContentBlock | AudioContentBlock}
 */
export function isMediaBlock(block) {
  return block.type === "image" || block.type === "video" || block.type === "audio";
}

/**
 * Register a media block in the registry.
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
 * Drop tool messages whose assistant message (with the matching tool_call)
 * is not present in the window. With stub-based tool results, ordering and
 * missing-result problems are solved at write time — this only handles the
 * window-boundary case where the assistant falls outside the history window.
 * @param {Message[]} messages
 * @returns {Message[]}
 */
function dropUnpairedToolMessages(messages) {
  /** @type {Set<string>} */
  const pairedToolIds = new Set();
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const block of msg.content) {
        if (block.type === "tool") {
          pairedToolIds.add(block.tool_id);
        }
      }
    }
  }

  return messages.filter(
    msg => msg.role !== "tool" || pairedToolIds.has(msg.tool_id),
  );
}

/**
 * Prepare stored Message[] rows from the DB for LLM consumption.
 * Reverses from DB order (newest-first) to chronological,
 * removes orphaned tool results, and builds a media registry.
 * Returns internal Message[] — no OpenAI conversion.
 * @param {Array<{message_data: Message, sender_id: string}>} chatMessages - Rows from DB (newest first)
 * @returns {{messages: Message[], mediaRegistry: MediaRegistry}}
 */
export function prepareMessages(chatMessages) {
  /** @type {Message[]} */
  const messages = [];
  /** @type {MediaRegistry} */
  const mediaRegistry = new Map();
  const reversedMessages = [...chatMessages].reverse();

  for (const msg of reversedMessages) {
    if (!msg.message_data) continue;
    const messageData = msg.message_data;

    // Scan for media blocks and register them
    if (messageData.role === "user") {
      for (const block of messageData.content) {
        if (isMediaBlock(block)) {
          registerMedia(mediaRegistry, block);
        } else if (block.type === "quote") {
          for (const quoteBlock of block.content) {
            if (isMediaBlock(quoteBlock)) {
              registerMedia(mediaRegistry, quoteBlock);
            }
          }
        }
      }
    } else if (messageData.role === "tool") {
      for (const block of messageData.content) {
        if (isMediaBlock(block)) {
          registerMedia(mediaRegistry, block);
        }
      }
    }

    messages.push(messageData);
  }

  return { messages: dropUnpairedToolMessages(messages), mediaRegistry };
}

/**
 * Render a single content block into a plain text representation.
 * Images/videos/audio produce descriptive placeholders; quotes become blockquotes.
 * @param {IncomingContentBlock | ToolContentBlock | ToolCallContentBlock} block
 * @returns {string}
 */
export function renderContentBlock(block) {
  switch (block.type) {
    case "text":
      return block.text;
    case "image":
      return block.alt ? `[Image: ${block.alt}]` : "[Image]";
    case "video":
      return block.alt ? `[Video: ${block.alt}]` : "[Video]";
    case "audio":
      return "[Audio message]";
    case "markdown":
      return block.text;
    case "quote": {
      const quotedParts = block.content
        .map((/** @type {IncomingContentBlock} */ qb) => renderContentBlock(qb))
        .filter((/** @type {string} */ s) => s.length > 0);
      if (quotedParts.length === 0) return "";
      const sender = block.quotedSenderId ? `[Quoted from ${block.quotedSenderId}] ` : "";
      const quotedText = quotedParts.join(" ").trim().replace(/\n/g, "\n> ");
      return `${sender}> ${quotedText}`;
    }
    default:
      return "";
  }
}

/**
 * Format conversation history from Message[] into a readable string.
 * @param {Message[]} messages
 * @returns {string}
 */
export function formatConversationHistory(messages) {
  /** @type {string[]} */
  const lines = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      const parts = msg.content
        .map((/** @type {IncomingContentBlock | ToolContentBlock} */ b) => renderContentBlock(b))
        .filter((/** @type {string} */ s) => s.length > 0);
      if (parts.length > 0) lines.push(`User: ${parts.join("\n")}`);
    } else if (msg.role === "assistant") {
      const parts = msg.content
        .map((/** @type {TextContentBlock | ToolCallContentBlock} */ b) => renderContentBlock(b))
        .filter((/** @type {string} */ s) => s.length > 0);
      if (parts.length > 0) lines.push(`Assistant: ${parts.join("\n")}`);
    }
    // Tool messages are implementation details — skip them
  }
  return lines.join("\n");
}

/**
 * Extract the last user text from the messages array, including quoted content.
 * @param {Message[]} messages
 * @returns {string}
 */
export function extractLastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user") {
      const parts = msg.content
        .map((/** @type {IncomingContentBlock | ToolContentBlock} */ b) => renderContentBlock(b))
        .filter((/** @type {string} */ s) => s.length > 0);
      if (parts.length > 0) return parts.join("\n");
    }
  }
  return "";
}
