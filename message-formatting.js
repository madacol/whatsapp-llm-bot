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
 * Result of parsing a structured question from freeform LLM text.
 * @typedef {{
 *   preamble: string;
 *   question: string;
 *   options: string[];
 * }} ParsedQuestion
 */

/**
 * Parse freeform LLM text to detect structured question patterns.
 *
 * Detection strategies (in priority order):
 * 1. **List-based**: numbered (`1. …`) or bullet (`- …`, `* …`) lists with 2–10 items
 * 2. **Inline or-options**: "Would you prefer A or B?" / "A, B, or C?"
 * 3. **Yes/no questions**: "Would you like…?", "Should I…?", "Do you want…?"
 *
 * Returns the surrounding text as `preamble`, the detected question line,
 * and the extracted option labels.
 *
 * Returns `null` if no structured question is found.
 * @param {string} text
 * @returns {ParsedQuestion | null}
 */
export function parseStructuredQuestion(text) {
  // Strategy 1: List-based detection
  const listResult = parseListQuestion(text);
  if (listResult) return listResult;

  // Strategy 2: Inline "A or B" options
  const orResult = parseInlineOrQuestion(text);
  if (orResult) return orResult;

  // Strategy 3: Yes/no confirmation questions
  const yesNoResult = parseYesNoQuestion(text);
  if (yesNoResult) return yesNoResult;

  return null;
}

/**
 * Detect numbered/bulleted list questions.
 * @param {string} text
 * @returns {ParsedQuestion | null}
 */
function parseListQuestion(text) {
  const lines = text.split("\n");

  /** @type {{ start: number; end: number; items: string[] }[]} */
  const runs = [];
  let currentRun = /** @type {{ start: number; end: number; items: string[] } | null} */ (null);

  for (let i = 0; i < lines.length; i++) {
    const numbered = lines[i].match(/^\s*(\d+)[.)]\s+(.+)/);
    const bulleted = lines[i].match(/^\s*[-*•]\s+(.+)/);
    const label = numbered ? numbered[2].trim() : bulleted ? bulleted[1].trim() : null;

    if (label) {
      if (!currentRun) {
        currentRun = { start: i, end: i, items: [label] };
      } else {
        currentRun.end = i;
        currentRun.items.push(label);
      }
    } else {
      if (currentRun && currentRun.items.length >= 2) {
        runs.push(currentRun);
      }
      currentRun = null;
    }
  }
  if (currentRun && currentRun.items.length >= 2) {
    runs.push(currentRun);
  }

  if (runs.length === 0) return null;

  const best = runs.reduce((a, b) => (b.items.length > a.items.length ? b : a));
  if (best.items.length > 10) return null;

  const preamble = lines.slice(0, best.start).join("\n").trim();

  let question = "";
  if (best.start > 0) {
    const candidate = lines[best.start - 1].trim();
    if (candidate.endsWith("?") || candidate.endsWith(":")) {
      question = candidate;
    }
  }
  if (!question && preamble) {
    const preambleLines = preamble.split("\n");
    const lastLine = preambleLines[preambleLines.length - 1].trim();
    question = lastLine;
  }

  const trailing = lines.slice(best.end + 1).join("\n").trim();
  const fullPreamble = trailing
    ? `${preamble}\n\n${trailing}`.trim()
    : preamble;

  return { preamble: fullPreamble, question, options: best.items };
}

/**
 * Detect inline "A or B" / "A, B, or C" option patterns in question sentences.
 * Only triggers on sentences ending with "?" that contain "or" between distinct options.
 * @param {string} text
 * @returns {ParsedQuestion | null}
 */
function parseInlineOrQuestion(text) {
  const lines = text.split("\n");

  // Find the last line ending with "?" — that's likely the question
  let questionLine = "";
  let questionIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed.endsWith("?")) {
      questionLine = trimmed;
      questionIdx = i;
      break;
    }
  }
  if (!questionLine) return null;

  // Match patterns like: "A or B", "A, B, or C", "A, B, C, or D"
  // Look for the "or" separated options at the end of the question
  const orMatch = questionLine.match(/(?:^|.*?\b)(?:prefer|choose|want|like|pick|go with|between)\b.*?\b(.+?)\s+or\s+(.+?)\?$/i)
    || questionLine.match(/\b(.+?),\s+(.+?),?\s+or\s+(.+?)\?$/i)
    || questionLine.match(/\b(.+?)\s+or\s+(.+?)\?$/i);

  if (!orMatch) return null;

  // Extract options from the match groups
  const rawOptions = orMatch.slice(1).map(s => s.trim().replace(/\*+/g, "").replace(/\?$/, "").trim());

  // For "A, B, or C" pattern — split on commas in the first group
  /** @type {string[]} */
  let options = [];
  if (rawOptions.length === 2) {
    // Could be "A, B" in first group + "C" — check for commas
    const firstParts = rawOptions[0].split(/,\s*/);
    if (firstParts.length > 1) {
      options = [...firstParts, rawOptions[1]];
    } else {
      options = rawOptions;
    }
  } else {
    options = rawOptions;
  }

  // Filter out empty/too-long options (too long = probably not real options)
  options = options.filter(o => o.length > 0 && o.length <= 80);
  if (options.length < 2) return null;

  const preambleLines = lines.slice(0, questionIdx);
  const trailingLines = lines.slice(questionIdx + 1);
  const preambleParts = [preambleLines.join("\n").trim(), trailingLines.join("\n").trim()]
    .filter(s => s.length > 0);

  return {
    preamble: preambleParts.join("\n\n"),
    question: questionLine,
    options,
  };
}

/** Patterns that indicate a yes/no or confirmation question */
const YES_NO_PATTERNS = [
  /\b(?:would you like|do you want|shall I|should I|can I|may I|want me to)\b.*\?$/i,
  /\b(?:proceed|continue|go ahead|confirm|ready)\b.*\?$/i,
  /\b(?:is that (?:ok|okay|correct|right|fine))\b.*\?$/i,
  /\b(?:does that (?:work|sound good|make sense))\b.*\?$/i,
  /\b(?:are you (?:sure|okay|ok|ready))\b.*\?$/i,
];

/**
 * Detect yes/no confirmation questions.
 * Matches common patterns like "Would you like me to…?", "Should I proceed?", etc.
 * @param {string} text
 * @returns {ParsedQuestion | null}
 */
function parseYesNoQuestion(text) {
  const lines = text.split("\n");

  // Find the last line ending with "?"
  let questionLine = "";
  let questionIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed.endsWith("?")) {
      questionLine = trimmed;
      questionIdx = i;
      break;
    }
  }
  if (!questionLine) return null;

  const isYesNo = YES_NO_PATTERNS.some(p => p.test(questionLine));
  if (!isYesNo) return null;

  const preambleLines = lines.slice(0, questionIdx);
  const trailingLines = lines.slice(questionIdx + 1);
  const preambleParts = [preambleLines.join("\n").trim(), trailingLines.join("\n").trim()]
    .filter(s => s.length > 0);

  return {
    preamble: preambleParts.join("\n\n"),
    question: questionLine,
    options: ["Yes", "No"],
  };
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
