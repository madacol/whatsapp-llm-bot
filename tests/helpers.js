import fs from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { initStore } from "../store.js";

const MODELS_CACHE_PATH = path.resolve("data/models.json");

/**
 * Pre-create a chat row in the test DB.
 * @param {PGlite} db
 * @param {string} chatId
 * @param {{enabled?: boolean, systemPrompt?: string | null, model?: string | null}} [options]
 */
export async function seedChat(db, chatId, options = {}) {
  const enabled = options.enabled ?? false;
  const systemPrompt = options.systemPrompt ?? null;
  const model = options.model ?? null;
  await db.sql`INSERT INTO chats(chat_id, is_enabled, system_prompt, model)
    VALUES (${chatId}, ${enabled}, ${systemPrompt}, ${model})
    ON CONFLICT (chat_id) DO NOTHING`;
}

/**
 * Write a models cache file, run fn, then clean up.
 * @param {object[]} models
 * @param {() => Promise<void>} fn
 */
export async function withModelsCache(models, fn) {
  await fs.mkdir(path.dirname(MODELS_CACHE_PATH), { recursive: true });
  await fs.writeFile(MODELS_CACHE_PATH, JSON.stringify(models));
  try {
    await fn();
  } finally {
    await fs.rm(MODELS_CACHE_PATH, { force: true });
  }
}

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
    sendImage: async (_image, caption) => {
      responses.push({ type: "sendImage", text: caption || "" });
    },
    sendVideo: async (_video, caption) => {
      responses.push({ type: "sendVideo", text: caption || "" });
    },
    confirm: async (message) => {
      responses.push({ type: "confirm", text: message });
      return true;
    },
    sendPresenceUpdate: async (presence) => {
      responses.push({ type: "sendPresenceUpdate", text: presence });
    },
    ...overrides,
  };

  return { context, responses };
}

/** @type {PGlite | null} */
let sharedTestDb = null;

/**
 * Create (or return cached) in-memory PGlite with the full app schema.
 * @returns {Promise<PGlite>}
 */
export async function createTestDb() {
  if (sharedTestDb) return sharedTestDb;
  const db = new PGlite("memory://", { extensions: { vector } });
  await initStore(db);
  sharedTestDb = db;
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
 *   addResponses: (...responses: Array<string | {tool_calls: any[]}>) => {clear: () => void},
 *   getRequests: () => object[],
 *   clearRequests: () => void,
 *   pendingResponses: () => number,
 * }>}
 */
export async function createMockLlmServer() {
  /** @type {Array<Array<string | {tool_calls: any[]}>>} */
  const scopes = [];
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

      // Handle embedding requests separately — return a dummy embedding
      if (req.url?.includes("/embeddings")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          object: "list",
          data: [{ object: "embedding", index: 0, embedding: Array.from({ length: 3 }, () => Math.random()) }],
          model: "mock-embedding",
          usage: { prompt_tokens: 1, total_tokens: 1 },
        }));
        return;
      }

      requests.push(parsed);

      const scope = scopes.find(s => s.length > 0);
      const next = scope?.shift();
      // Auto-remove empty scopes from the front
      while (scopes.length > 0 && scopes[0].length === 0) scopes.shift();
      if (next === undefined) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: { message: "No more mock responses in queue" },
          }),
        );
        return;
      }

      /** @type {{ role: string, content: string | null, tool_calls?: any[] }} */
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
        responseMessage = { role: "assistant", content: null };
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
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
          prompt_tokens_details: { cached_tokens: 8 },
          cost: 0.001,
        },
      };

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  return {
    url: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
    addResponses: (...responses) => {
      /** @type {Array<string | {tool_calls: any[]}>} */
      const scope = [...responses];
      scopes.push(scope);
      return {
        clear: () => {
          const idx = scopes.indexOf(scope);
          if (idx !== -1) scopes.splice(idx, 1);
        },
      };
    },
    getRequests: () => requests,
    clearRequests: () => { requests.length = 0; },
    pendingResponses: () => scopes.reduce((n, s) => n + s.length, 0),
  };
}

