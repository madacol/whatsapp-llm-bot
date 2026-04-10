/**
 * Pure functions extracted from index.js for testability.
 */

import { deriveMediaPath, hasInlineMediaData, hasMediaPath, isValidMediaPath } from "./attachment-paths.js";
import { hydrateHdRef } from "./whatsapp-hd-media.js";
import { createImageBlockFromPath } from "./media-store.js";

/**
 * Convert a single property schema, replacing custom `type: "image"` with
 * `type: "string"` and a description hint for the LLM to pass media file paths.
 * @param {{ type: string, description?: string, items?: { type: string } }} propSchema
 * @param {boolean} hasMedia
 * @returns {Record<string, unknown>}
 */
function convertImageProp(propSchema, hasMedia) {
  const hint = hasMedia
    ? "Pass the media file path from the conversation (for example, <sha>.jpg)."
    : "Image file path (no media available).";
  if (propSchema.type === "image") {
    return {
      ...propSchema,
      type: "string",
      description: propSchema.description ? `${propSchema.description}. ${hint}` : hint,
    };
  }
  if (propSchema.type === "array" && propSchema.items?.type === "image") {
    return {
      ...propSchema,
      type: "array",
      items: { type: "string" },
      description: propSchema.description ? `${propSchema.description}. ${hint}` : hint,
    };
  }
  return propSchema;
}

/**
 * Convert actions to tool definitions format.
 * Converts `type: "image"` parameters to `type: "string"` with a media path hint.
 * @param {ToolDescriptor[]} actions
 * @param {boolean} [hasMedia]
 * @returns {ToolDefinition[]}
 */
export function actionsToToolDefinitions(actions, hasMedia) {
  return actions.map((action) => {
    /** @type {Record<string, unknown>} */
    const convertedProperties = {};
    let hasImageParams = false;
    for (const [key, propSchema] of Object.entries(action.parameters.properties)) {
      const converted = convertImageProp(propSchema, !!hasMedia);
      if (converted !== propSchema) hasImageParams = true;
      convertedProperties[key] = converted;
    }

    const parameters = hasImageParams
      ? { ...action.parameters, properties: convertedProperties }
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
 * Parse a media path reference string.
 * Accepts only the canonical `<sha>.<ext>` form.
 * @param {unknown} ref
 * @returns {string | null}
 */
function parseMediaRef(ref) {
  return typeof ref === "string" && isValidMediaPath(ref) ? ref : null;
}

/**
 * Resolve image parameter values from media path strings to ImageContentBlocks.
 * Walks the action's parameter schema and replaces any `type: "image"` param values
 * with a content block keyed by that media path.
 * @param {Action['parameters']} schema
 * @param {Record<string, unknown>} args
 * @param {MediaRegistry} mediaRegistry
 * @returns {Record<string, unknown>} Args with resolved image blocks
 */
export function resolveImageArgs(schema, args, mediaRegistry) {
  const resolved = { ...args };
  for (const [key, propSchema] of Object.entries(schema.properties)) {
    const prop = /** @type {{ type: string, items?: { type: string } }} */ (propSchema);
    if (prop.type === "image") {
      const mediaPath = parseMediaRef(args[key]);
      if (mediaPath !== null) {
        resolved[key] = mediaRegistry.get(mediaPath) ?? createImageBlockFromPath(mediaPath);
      }
    } else if (prop.type === "array" && prop.items?.type === "image") {
      const refs = Array.isArray(args[key]) ? args[key] : [];
      resolved[key] = refs
        .map((/** @type {unknown} */ r) => {
          const mediaPath = parseMediaRef(r);
          if (mediaPath === null) return null;
          return mediaRegistry.get(mediaPath) ?? createImageBlockFromPath(mediaPath);
        })
        .filter(/** @type {(b: unknown) => b is IncomingContentBlock} */ (b) => b !== null);
    }
  }
  return resolved;
}

/**
 * Decide whether the bot should respond to a message.
 * @param {import("./store.js").ChatRow | undefined} chatInfo
 * @param {TurnFacts} facts
 * @returns {boolean}
 */
export function shouldRespond(chatInfo, facts) {
  if (!chatInfo?.is_enabled) {
    return false;
  }

  if (!facts.isGroup) {
    return true;
  }

  const mode = chatInfo.respond_on ?? "mention";

  if (mode === "any") {
    return true;
  }

  if (facts.addressedToBot) {
    return true;
  }

  if (mode === "mention+reply" && facts.repliedToBot) {
    return true;
  }

  return false;
}

/**
 * Format a user message with timestamp and (for groups) sender name.
 * Bot mention stripping now happens during transport normalization.
 * Returns the formatted text and an optional system prompt suffix.
 * @param {TextContentBlock} firstBlock
 * @param {boolean} isGroup
 * @param {string} senderName
 * @param {string} time
 * @returns {{ formattedText: string, systemPromptSuffix: string }}
 */
export function formatUserMessage(firstBlock, isGroup, senderName, time) {
  let formattedText;
  let systemPromptSuffix = "";

  if (isGroup) {
    formattedText = `[${time}] ${senderName}: ${firstBlock.text}`;
    systemPromptSuffix = `\n\nYou are in a group chat`;
  } else {
    formattedText = `[${time}] ${firstBlock.text}`;
  }

  return { formattedText, systemPromptSuffix };
}

/**
 * Strip the generated chat prefix that conversation storage adds to the first
 * user text block before text-only harnesses synthesize their prompt.
 * The timestamp prefix is removed for both private and group chats. The sender
 * name segment is removed only for group chats, where it was injected by the
 * transport formatter.
 * @param {string} text
 * @param {boolean} isGroupChat
 * @returns {string}
 */
export function stripTextHarnessMessagePrefix(text, isGroupChat) {
  const timestampMatch = text.match(/^\[\d{2}\/\d{2}\/\d{4}, \d{1,2}:\d{2}(?:\s?[AP]M)?\]\s/u);
  if (!timestampMatch) {
    return text;
  }

  let strippedText = text.slice(timestampMatch[0].length);
  if (isGroupChat) {
    strippedText = strippedText.replace(/^[^:\n]{1,120}:\s/u, "");
  }

  return strippedText;
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
 * Check whether a content block is a path-addressable attachment.
 * @param {IncomingContentBlock | ToolContentBlock} block
 * @returns {block is ImageContentBlock | VideoContentBlock | AudioContentBlock | FileContentBlock}
 */
export function isAttachmentBlock(block) {
  return isMediaBlock(block) || block.type === "file";
}

/**
 * Register an attachment block in the registry.
 * @param {MediaRegistry} registry
 * @param {ImageContentBlock | VideoContentBlock | AudioContentBlock | FileContentBlock} block
 * @returns {string} The canonical media path
 */
export function registerMedia(registry, block) {
  let mediaPath;
  if (hasMediaPath(block)) {
    mediaPath = block.path;
  } else if (hasInlineMediaData(block)) {
    mediaPath = deriveMediaPath(Buffer.from(block.data, "base64"), block.mime_type, block.type);
    const withPath = /** @type {(ImageContentBlock | VideoContentBlock | AudioContentBlock | FileContentBlock) & { path?: string }} */ (block);
    withPath.path = mediaPath;
  } else {
    throw new Error("Unsupported media block for registry");
  }
  registry.set(mediaPath, block);
  return mediaPath;
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

    // Scan for media blocks, hydrate HD refs, and register them
    if (messageData.role === "user") {
      for (const block of messageData.content) {
        if (isAttachmentBlock(block)) {
          if (block.type === "image") hydrateHdRef(/** @type {ImageContentBlock} */ (block));
          registerMedia(mediaRegistry, block);
        } else if (block.type === "quote") {
          for (const quoteBlock of block.content) {
            if (isAttachmentBlock(quoteBlock)) {
              if (quoteBlock.type === "image") hydrateHdRef(/** @type {ImageContentBlock} */ (quoteBlock));
              registerMedia(mediaRegistry, quoteBlock);
            }
          }
        }
      }
    } else if (messageData.role === "tool") {
      for (const block of messageData.content) {
        if (isAttachmentBlock(block)) {
          if (block.type === "image") hydrateHdRef(/** @type {ImageContentBlock} */ (block));
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
    case "file":
      return block.file_name ? `[File: ${block.file_name}]` : "[File]";
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

  let question = "";
  // Check whether the line immediately before the list is a question/heading
  let questionLineIdx = -1;
  if (best.start > 0) {
    const candidate = lines[best.start - 1].trim();
    if (candidate.endsWith("?") || candidate.endsWith(":")) {
      question = candidate;
      questionLineIdx = best.start - 1;
    }
  }

  // Exclude the question line from the preamble to avoid duplication
  const preambleEnd = questionLineIdx >= 0 ? questionLineIdx : best.start;
  const preamble = lines.slice(0, preambleEnd).join("\n").trim();

  // Fall back to the last preamble line as the question if none was found
  if (!question && preamble) {
    const preambleLines = preamble.split("\n");
    question = preambleLines[preambleLines.length - 1].trim();
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
