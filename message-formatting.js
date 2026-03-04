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
 * Normalize tool message ordering so each tool result immediately follows its
 * assistant message, orphaned tool results are dropped, and missing tool results
 * get placeholders. Works on internal Message[] types.
 * @param {Message[]} messages
 * @returns {Message[]}
 */
function removeOrphanedToolResults(messages) {
  // Map each tool_call id → index of the assistant message that owns it
  /** @type {Map<string, number>} */
  const toolCallOwner = new Map();

  // Track which tool_call ids each assistant message expects
  /** @type {Map<number, string[]>} */
  const assistantToolCallIds = new Map();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      const toolBlocks = msg.content.filter(
        /** @returns {b is ToolCallContentBlock} */
        (b) => b.type === "tool"
      );
      if (toolBlocks.length > 0) {
        const ids = toolBlocks.map(b => b.tool_id);
        assistantToolCallIds.set(i, ids);
        for (const id of ids) {
          toolCallOwner.set(id, i);
        }
      }
    }
  }

  // Group tool result messages by their owning assistant index
  /** @type {Map<number, ToolMessage[]>} */
  const toolResultsByAssistant = new Map();

  // Collect non-tool messages in order, excluding tool results (we'll re-insert them)
  /** @type {Array<{ msg: Message, originalIndex: number }>} */
  const nonToolMessages = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "tool") {
      const ownerIdx = toolCallOwner.get(msg.tool_id);
      if (ownerIdx !== undefined) {
        if (!toolResultsByAssistant.has(ownerIdx)) {
          toolResultsByAssistant.set(ownerIdx, []);
        }
        /** @type {ToolMessage[]} */ (toolResultsByAssistant.get(ownerIdx)).push(msg);
      }
      // Orphaned tool results (no ownerIdx) are silently dropped
    } else {
      nonToolMessages.push({ msg, originalIndex: i });
    }
  }

  // Rebuild: for each non-tool message, emit it; after each assistant with
  // tool_calls, insert its grouped tool results + placeholders for missing ones
  /** @type {Message[]} */
  const result = [];

  for (const { msg, originalIndex } of nonToolMessages) {
    result.push(msg);

    if (assistantToolCallIds.has(originalIndex)) {
      const expectedIds = /** @type {string[]} */ (assistantToolCallIds.get(originalIndex));
      const actualResults = toolResultsByAssistant.get(originalIndex) ?? [];

      // Emit actual results in their expected order
      for (const id of expectedIds) {
        const existing = actualResults.find(m => m.tool_id === id);
        if (existing) {
          result.push(existing);
        } else {
          // Placeholder for missing tool result
          result.push({
            role: "tool",
            tool_id: id,
            content: [{ type: "text", text: "[tool result unavailable]" }],
          });
        }
      }
    }
  }

  return result;
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
        if (block.type === "image" || block.type === "video" || block.type === "audio") {
          registerMedia(mediaRegistry, block);
        } else if (block.type === "quote") {
          for (const quoteBlock of block.content) {
            if (quoteBlock.type === "image" || quoteBlock.type === "video" || quoteBlock.type === "audio") {
              registerMedia(mediaRegistry, quoteBlock);
            }
          }
        }
      }
    } else if (messageData.role === "tool") {
      for (const block of messageData.content) {
        if (block.type === "image" || block.type === "video" || block.type === "audio") {
          registerMedia(mediaRegistry, block);
        }
      }
    }

    messages.push(messageData);
  }

  return { messages: removeOrphanedToolResults(messages), mediaRegistry };
}
