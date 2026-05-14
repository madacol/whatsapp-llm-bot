
export default /** @type {defineAction} */ ((x) => x)({
  name: "recall_history",
  description:
    "Fetch conversation messages from any time window. The main context already contains the last 8 hours. Call this when a user asks about something older or when you need a specific time range. Messages are returned oldest-first.",
  parameters: {
    type: "object",
    properties: {
      since: {
        type: "string",
        description:
          "ISO 8601 timestamp to start from (e.g. '2026-02-19T08:00:00Z' or '2026-02-19'). Returns messages from this time onward.",
      },
      until: {
        type: "string",
        description:
          "ISO 8601 timestamp upper bound. If omitted, returns messages up to now.",
      },
      limit: {
        type: "number",
        description: "Maximum number of messages to retrieve (default: 50)",
      },
    },
    required: ["since"],
  },
  formatToolCall: ({ since, until }) =>
    until ? `Recalling messages ${since} → ${until}` : `Recalling messages since ${since}`,
  permissions: {
    autoExecute: true,
    autoContinue: true,
    useChatDb: true,
  },
  action_fn: async function ({ chatId, chatDb }, params) {
    const since = params.since;
    if (!since || isNaN(new Date(since).getTime())) {
      return "Invalid timestamp for 'since': " + since + ". Please use an ISO 8601 timestamp (e.g. 2025-01-15T10:00:00Z).";
    }
    const until = params.until;
    if (until && isNaN(new Date(until).getTime())) {
      return "Invalid timestamp for 'until': " + until + ". Please use an ISO 8601 timestamp (e.g. 2025-01-15T10:00:00Z).";
    }
    const limit = params.limit || 50;

    const { rows } = until
      ? await chatDb.sql`
          SELECT message_id, sender_id, message_data, timestamp
          FROM messages
          WHERE chat_id = ${chatId}
            AND datetime(timestamp) >= datetime(${since})
            AND datetime(timestamp) <= datetime(${until})
          ORDER BY datetime(timestamp) ASC, message_id ASC
          LIMIT ${limit}
        `
      : await chatDb.sql`
          SELECT message_id, sender_id, message_data, timestamp
          FROM messages
          WHERE chat_id = ${chatId}
            AND datetime(timestamp) >= datetime(${since})
          ORDER BY datetime(timestamp) ASC, message_id ASC
          LIMIT ${limit}
        `;

    if (rows.length === 0) {
      return "No messages found in that time range.";
    }

    const lines = rows.map((row) => {
      const msg = row.message_data;
      const ts = typeof row.timestamp === "string" || row.timestamp instanceof Date
        ? new Date(row.timestamp).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z")
        : "";
      if (!isStoredMessage(msg)) {
        return `[${ts}] ${JSON.stringify(msg)}`;
      }
      const textParts = [];
      for (const block of msg.content) {
        if (block.type === "text" && typeof block.text === "string") {
          textParts.push(block.text);
        } else if (block.type === "tool" && typeof block.name === "string") {
          textParts.push(`[called ${block.name}(${block.arguments || ""})]`);
        }
      }
      const sender = row.sender_id ? ` (${row.sender_id})` : "";
      return `[${ts}] [${msg.role}]${sender}: ${textParts.join(" | ")}`;
    });

    return `Recalled ${rows.length} messages since ${since}:\n\n${lines.join("\n")}`;
  },
});

/**
 * @param {unknown} value
 * @returns {value is { role: string, content: Array<Record<string, unknown>> }}
 */
function isStoredMessage(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && typeof /** @type {{ role?: unknown }} */ (value).role === "string"
    && Array.isArray(/** @type {{ content?: unknown }} */ (value).content);
}
