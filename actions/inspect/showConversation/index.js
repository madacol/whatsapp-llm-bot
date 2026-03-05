
/** @type {Record<string, string>} */
const ROLE_ICONS = { user: "\u{1F464}", assistant: "\u{1F916}", tool: "\u{1F527}" };

/**
 * Extract readable text from a message_data object.
 * @param {{ role: string, content: Array<Record<string, unknown>>, tool_id?: string }} msg
 * @returns {string}
 */
function formatMessage(msg) {
  const icon = ROLE_ICONS[msg.role] || "\u{2753}";
  const parts = [];

  for (const block of msg.content) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "tool" && typeof block.name === "string") {
      const args = typeof block.arguments === "string" ? block.arguments : "";
      let parsed = "";
      try {
        const obj = JSON.parse(args);
        parsed = Object.entries(obj)
          .map(([k, v]) => `  ${k}: ${v}`)
          .join("\n");
      } catch {
        parsed = args ? `  ${args}` : "";
      }
      parts.push(`*${block.name}*\n${parsed}`.trim());
    } else if (block.type === "quote" && Array.isArray(block.content)) {
      const quoteText = block.content
        .filter((/** @type {Record<string, unknown>} */ b) => b.type === "text" && typeof b.text === "string")
        .map((/** @type {{ text: string }} */ b) => b.text)
        .join("\n");
      if (quoteText) parts.push(`> ${quoteText.split("\n").join("\n> ")}`);
    }
  }

  if (msg.role === "tool" && msg.tool_id) {
    // Tool results: show cleaned text
    const cleaned = parts.map((p) => p.replace(/^"|"$/g, "").replace(/\\n/g, "\n").replace(/\\"/g, '"'));
    return `${icon} *Tool result:*\n${cleaned.join("\n")}`;
  }

  const label = msg.role === "user" ? "User" : msg.role === "assistant" ? "Bot" : msg.role;
  return `${icon} *${label}:*\n${parts.join("\n")}`;
}

/**
 * Format a timestamp for display.
 * @param {string | Date} ts
 * @returns {string}
 */
function formatTimestamp(ts) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return String(ts);
  const pad = (/** @type {number} */ n) => String(n).padStart(2, "0");
  const hours = pad(d.getUTCHours());
  const minutes = pad(d.getUTCMinutes());
  const month = pad(d.getUTCMonth() + 1);
  const day = pad(d.getUTCDate());
  return `${month}/${day} ${hours}:${minutes}`;
}

export default /** @type {defineAction} */ ((x) => x)({
  name: "show_conversation",
  command: "history",
  description: "Show the conversation history for the current chat in a readable format",
  parameters: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Maximum number of messages to show (default: 20)",
      },
    },
    required: [],
  },
  formatToolCall: ({ limit }) => limit ? `Showing last ${limit} messages` : "Showing conversation",
  permissions: {
    autoExecute: true,
    autoContinue: true,
    useRootDb: true,
  },
  action_fn: async function ({ chatId, rootDb }, params) {
    const limit = params.limit || 20;
    const { rows } = await rootDb.sql`
      SELECT message_id, sender_id, message_data, timestamp
      FROM messages
      WHERE chat_id = ${chatId}
        AND cleared_at IS NULL
      ORDER BY message_id DESC
      LIMIT ${limit}
    `;

    if (rows.length === 0) {
      return "No conversation history found for this chat.";
    }

    // Reverse to show oldest first
    rows.reverse();

    const lines = rows.map((row) => {
      const msg = row.message_data;
      const ts = row.timestamp ? formatTimestamp(row.timestamp) : "";
      const body = (msg && typeof msg === "object" && Array.isArray(msg.content))
        ? formatMessage(msg)
        : JSON.stringify(msg);
      return `${ts}\n${body}`;
    });

    return `*Conversation history* (${rows.length} messages):\n\n${lines.join("\n\n---\n\n")}`;
  },
});
