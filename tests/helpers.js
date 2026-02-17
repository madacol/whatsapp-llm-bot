import { createServer } from "node:http";
import { PGlite } from "@electric-sql/pglite";

/**
 * Create an IncomingContext for testing.
 * Default sender is "master-user" (matches process.env.MASTER_ID in tests).
 * @param {Partial<IncomingContext>} [overrides]
 * @returns {{ context: IncomingContext, responses: Array<{type: string, text: string}> }}
 */
export function createIncomingContext(overrides = {}) {
  /** @type {Array<{type: string, text: string}>} */
  const responses = [];

  /** @type {IncomingContext} */
  const context = {
    chatId: "test-chat",
    senderIds: ["master-user"],
    senderName: "Test User",
    content: [{ type: "text", text: "Hello" }],
    isGroup: false,
    timestamp: new Date(),
    selfIds: ["bot-123"],
    selfName: "TestBot",
    getAdminStatus: async () => "admin",
    sendMessage: async (text) => {
      responses.push({ type: "sendMessage", text });
    },
    replyToMessage: async (text) => {
      responses.push({ type: "replyToMessage", text });
    },
    reactToMessage: async (emoji) => {
      responses.push({ type: "reactToMessage", text: emoji });
    },
    sendPoll: async (name, options, selectableCount) => {
      responses.push({ type: "sendPoll", text: JSON.stringify({ name, options, selectableCount }) });
    },
    confirm: async (message) => {
      responses.push({ type: "confirm", text: message });
      return true;
    },
    ...overrides,
  };

  return { context, responses };
}

/**
 * Create an in-memory PGlite with the full app schema (mirrors store.js)
 * @returns {Promise<PGlite>}
 */
export async function createTestDb() {
  const db = new PGlite("memory://");

  await db.sql`
    CREATE TABLE IF NOT EXISTS chats (
      chat_id VARCHAR(50) PRIMARY KEY,
      is_enabled BOOLEAN DEFAULT FALSE,
      system_prompt TEXT,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;
  await db.sql`
    CREATE TABLE IF NOT EXISTS messages (
      message_id SERIAL PRIMARY KEY,
      chat_id VARCHAR(50) REFERENCES chats(chat_id),
      sender_id VARCHAR(50),
      message_data JSONB,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;
  await db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS model TEXT`;
  await db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS respond_on_any BOOLEAN DEFAULT FALSE`;
  await db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS respond_on_mention BOOLEAN DEFAULT TRUE`;
  await db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS respond_on_reply BOOLEAN DEFAULT FALSE`;

  return db;
}

/**
 * Create a mock HTTP server that mimics the OpenAI /v1/chat/completions endpoint.
 *
 * Queue responses with `addResponses()`:
 *   - A string → text completion  (e.g. "Hello!")
 *   - An object with `tool_calls` → tool-call completion
 *
 * @returns {Promise<{
 *   url: string,
 *   close: () => Promise<void>,
 *   addResponses: (...responses: Array<string | {tool_calls: any[]}>) => void,
 *   getRequests: () => object[]
 * }>}
 */
export async function createMockLlmServer() {
  /** @type {Array<string | {tool_calls: any[]}>} */
  const queue = [];
  /** @type {object[]} */
  const requests = [];

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Invalid JSON" } }));
        return;
      }
      requests.push(parsed);

      const next = queue.shift();
      if (next === undefined) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: { message: "No more mock responses in queue" },
          }),
        );
        return;
      }

      /** @type {any} */
      let responseMessage;
      if (typeof next === "string") {
        responseMessage = { role: "assistant", content: next };
      } else if (next && typeof next === "object" && "tool_calls" in next) {
        responseMessage = {
          role: "assistant",
          content: null,
          tool_calls: next.tool_calls,
        };
      } else {
        responseMessage = next;
      }

      const response = {
        id: "chatcmpl-mock-" + Date.now(),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "mock-model",
        choices: [
          {
            index: 0,
            message: responseMessage,
            finish_reason: responseMessage.tool_calls ? "tool_calls" : "stop",
          },
        ],
      };

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  return {
    url: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise((resolve) => server.close(resolve)),
    addResponses: (...responses) => queue.push(...responses),
    getRequests: () => requests,
  };
}

