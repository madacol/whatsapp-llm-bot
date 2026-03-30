import { sendSimpleChatCompletion } from "../llm.js";
import { renderContentBlock } from "../message-formatting.js";
import { resolveModel } from "../model-roles.js";

const MAX_TITLE_MESSAGES = 12;
const MAX_TRANSCRIPT_CHARS = 4000;
const MAX_TITLE_LENGTH = 80;

/**
 * @param {Message} message
 * @returns {string}
 */
function renderMessageForTitle(message) {
  /** @type {string[]} */
  const parts = [];
  for (const block of message.content) {
    if (block.type === "tool" && typeof block.name === "string") {
      parts.push(`[Tool call: ${block.name}]`);
      continue;
    }
    const rendered = renderContentBlock(block);
    if (rendered) {
      parts.push(rendered);
    }
  }

  const text = parts.join("\n").trim();
  if (!text) {
    return "";
  }

  switch (message.role) {
    case "user":
      return `User: ${text}`;
    case "assistant":
      return `Assistant: ${text}`;
    case "tool":
      return `Tool: ${text}`;
    default:
      return text;
  }
}

/**
 * Build a compact transcript from recent messages for title generation.
 * @param {Array<{ message_data: Message }>} rows
 * @returns {string}
 */
export function buildSessionTitleTranscript(rows) {
  const recentRows = rows.slice(0, MAX_TITLE_MESSAGES).reverse();
  /** @type {string[]} */
  const lines = [];
  let currentLength = 0;

  for (let i = recentRows.length - 1; i >= 0; i--) {
    const line = renderMessageForTitle(recentRows[i].message_data);
    if (!line) {
      continue;
    }
    const nextLength = currentLength === 0 ? line.length : currentLength + 1 + line.length;
    if (nextLength > MAX_TRANSCRIPT_CHARS) {
      break;
    }
    lines.unshift(line);
    currentLength = nextLength;
  }

  return lines.join("\n");
}

/**
 * Normalize the LLM response into a short single-line session title.
 * @param {string | null} raw
 * @returns {string | null}
 */
export function normalizeSessionTitle(raw) {
  if (typeof raw !== "string") {
    return null;
  }

  let title = raw.trim();
  if (!title) {
    return null;
  }

  const firstLine = title.split(/\r?\n/, 1)[0];
  title = firstLine.replace(/^title\s*:\s*/i, "").trim();
  title = title.replace(/^["'`]+|["'`]+$/g, "").trim();
  title = title.replace(/\s+/g, " ");

  if (!title) {
    return null;
  }

  if (title.length > MAX_TITLE_LENGTH) {
    title = title.slice(0, MAX_TITLE_LENGTH).trimEnd();
  }

  return title || null;
}

/**
 * Generate a short human-readable title for the active session.
 * @param {{
 *   llmClient: LlmClient,
 *   chatInfo: import("../store.js").ChatRow | undefined,
 *   messageRows: Array<{ message_data: Message }>,
 * }} input
 * @returns {Promise<string | null>}
 */
export async function generateSessionTitle({ llmClient, chatInfo, messageRows }) {
  const transcript = buildSessionTitleTranscript(messageRows);
  if (!transcript) {
    return null;
  }

  const model = resolveModel("fast", chatInfo);
  const raw = await sendSimpleChatCompletion(llmClient, model, [
    {
      role: "system",
      content: "Write a short session title for this conversation. Use 2 to 6 words. Reply with the title only, no quotes, no prefix, no punctuation unless necessary.",
    },
    {
      role: "user",
      content: [{ type: "text", text: transcript }],
    },
  ]);

  return normalizeSessionTitle(raw);
}
