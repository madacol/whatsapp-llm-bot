import fs from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { formatActivitySummary } from "../tool-presentation-model.js";
import { formatToolPresentationDisplay, formatToolPresentationSummary } from "../presentation/whatsapp.js";
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
 * @typedef {Partial<Omit<ChatTurn, "facts" | "io">> & {
 *   facts?: Partial<TurnFacts>;
 *   io?: Partial<TurnIO>;
 * }} ChatTurnOverrides
 */

/**
 * Create a test ChatTurn.
 * Default sender is "master-user" (matches process.env.MASTER_ID in tests).
 * @param {ChatTurnOverrides} [overrides]
 * @returns {{ context: ChatTurn, responses: Array<{type: string, text: string, source?: MessageSource, blockType?: string}> }}
 */
export function createChatTurn(overrides = {}) {
  /** @type {Array<{type: string, text: string, source?: MessageSource, blockType?: string}>} */
  const responses = [];

  /**
   * Record blocks from a send/reply call and return a MessageHandle
   * that records subsequent semantic updates.
   * @param {"send" | "reply"} method
   * @param {OutboundEvent} event
   * @returns {MessageHandle}
   */
  const recordBlocks = (method, event) => {
    /** @type {MessageSource} */
    let source;
    /** @type {SendContent} */
    let content;
    switch (event.kind) {
      case "content":
        source = event.source;
        content = event.content;
        break;
      case "tool_call":
        source = "tool-call";
        content = formatToolPresentationDisplay(event.presentation) ?? formatToolPresentationSummary(event.presentation);
        break;
      case "tool_activity":
        source = "tool-call";
        content = formatActivitySummary(event.activity);
        break;
      case "plan":
        source = "llm";
        content = [{ type: "markdown", text: `*Plan*\n\n${event.text}` }];
        break;
      case "usage":
        source = "usage";
        content = `Cost: ${event.cost} | prompt=${event.tokens.prompt} cached=${event.tokens.cached} completion=${event.tokens.completion}`;
        break;
      case "file_change":
        source = "tool-call";
        content = event.summary ?? event.path;
        break;
      default:
        source = "tool-result";
        content = "";
        break;
    }
    const blocks = typeof content === "string"
      ? [/** @type {ToolContentBlock} */ ({ type: "text", text: content })]
      : Array.isArray(content) ? content : [content];
    for (const block of blocks) {
      const text = block.type === "text" ? block.text
        : block.type === "markdown" ? block.text
        : block.type === "code" ? block.code
        : ("alt" in block && block.alt) || "";
      responses.push({ type: method, text, source, blockType: block.type });
    }
    /** @type {MessageHandle} */
    const handle = {
      keyId: `mock-key-${responses.length}`,
      isImage: blocks.some(b => b.type === "image" || b.type === "code" || b.type === "diff"),
      update: async (update) => {
        const text = update.kind === "text"
          ? update.text
          : update.kind === "tool_call"
            ? formatToolPresentationSummary(update.presentation)
            : update.state.title;
        responses.push({ type: "edit", text, source });
      },
      setInspect: () => {},
    };
    return handle;
  };

  /** @type {TurnIO} */
  const io = {
    getIsAdmin: async () => true,
    react: async (emoji) => {
      responses.push({ type: "reactToMessage", text: emoji });
    },
    select: async (question, options) => {
      responses.push({ type: "select", text: JSON.stringify({ question, options }) });
      return "";
    },
    send: async (event) => recordBlocks("send", event),
    reply: async (event) => recordBlocks("reply", event),
    confirm: async (message) => {
      responses.push({ type: "confirm", text: message });
      return true;
    },
    setWorking: async (working) => {
      responses.push({ type: "sendPresenceUpdate", text: working ? "composing" : "paused" });
    },
  };

  /** @type {TurnIO} */
  const finalIo = {
    ...io,
    ...(overrides.io ?? {}),
  };

  const content = overrides.content ?? [{ type: "text", text: "Hello" }];
  const testBotIds = ["bot-123"];
  const quotedSenderId = overrides.facts?.quotedSenderId;
  const addressedToBot = content.some((block) => block.type === "text"
    && testBotIds.some((selfId) => block.text.includes(`@${selfId}`)));
  const repliedToBot = quotedSenderId != null && testBotIds.includes(quotedSenderId);

  /** @type {TurnFacts} */
  const facts = {
    isGroup: overrides.facts?.isGroup ?? false,
    addressedToBot: overrides.facts?.addressedToBot ?? addressedToBot,
    repliedToBot: overrides.facts?.repliedToBot ?? repliedToBot,
    ...(quotedSenderId != null && { quotedSenderId }),
  };

  /** @type {ChatTurn} */
  const context = {
    chatId: overrides.chatId ?? "test-chat",
    senderIds: overrides.senderIds ?? ["master-user"],
    senderName: overrides.senderName ?? "Test User",
    chatName: overrides.chatName,
    content,
    timestamp: overrides.timestamp ?? new Date(),
    facts,
    io: finalIo,
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
        const floats = Array.from({ length: 3 }, () => Math.random());
        const useBase64 = parsed.encoding_format === "base64";
        const embeddingValue = useBase64
          ? Buffer.from(new Float32Array(floats).buffer).toString("base64")
          : floats;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          object: "list",
          data: [{ object: "embedding", index: 0, embedding: embeddingValue }],
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

// ── Test harness for integration tests ──

/**
 * Build a verbose tool_calls mock object from a name + args.
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @returns {{ tool_calls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }}
 */
export function toolCall(name, args) {
  return {
    tool_calls: [{
      id: `call_${name}_${Math.random().toString(36).slice(2, 6)}`,
      type: /** @type {const} */ ("function"),
      function: { name, arguments: JSON.stringify(args) },
    }],
  };
}

/**
 * @typedef {{
 *   enabled?: boolean;
 *   debug?: boolean;
 *   model?: string | null;
 *   systemPrompt?: string | null;
 *   memory?: boolean;
 *   memoryThreshold?: number | null;
 *   respondOn?: "any" | "mention+reply" | "mention";
 *   enabledActions?: string[];
 *   persona?: string | null;
 *   modelRoles?: Record<string, string>;
 *   mediaToTextModels?: { image?: string; audio?: string; video?: string; general?: string };
 * }} ChatConfig
 */

/**
 * @typedef {{
 *   sends: string[];
 *   replies: string[];
 *   all: string[];
 *   reactions: string[];
 *   confirms: string[];
 *   polls: Array<{name: string, options: string[], selectableCount: number}>;
 *   images: string[];
 *   videos: string[];
 *   presence: string[];
 *   requests: object[];
 *   raw: Array<{type: string, text: string, source?: MessageSource, blockType?: string}>;
 * }} SendResult
 */

/**
 * @typedef {{ image: string; mime: string; caption?: string }
 *   | { video: string; mime: string; caption?: string }
 *   | { audio: string; mime: string }
 * } MediaInput
 */

/**
 * @typedef {{
 *   llm?: Array<string | {tool_calls: any[]}>;
 *   sender?: { id?: string; name?: string; lid?: string };
 *   isGroup?: boolean;
 *   quote?: { text: string; senderId?: string };
 *   confirm?: boolean | ((msg: string) => boolean);
 * }} SendOptions
 */

/**
 * @typedef {{
 *   send: (input: string | MediaInput | {content: IncomingContentBlock[]}, options?: SendOptions) => Promise<SendResult>;
 * }} TestChat
 */

/**
 * Create a test harness that reduces integration test boilerplate.
 *
 * @param {{
 *   mockServer: Awaited<ReturnType<typeof createMockLlmServer>>;
 *   handleMessage: (msg: ChatTurn) => Promise<void>;
 *   testDb: import("@electric-sql/pglite").PGlite;
 * }} deps
 * @returns {{ chat: (chatId: string, config?: ChatConfig) => Promise<TestChat> }}
 */
export function createTestHarness({ mockServer, handleMessage, testDb }) {
  /**
   * Create/seed a chat row and return a TestChat with a `send()` method.
   * @param {string} chatId
   * @param {ChatConfig} [config]
   * @returns {Promise<TestChat>}
   */
  async function chat(chatId, config = {}) {
    const { enabled, systemPrompt, model, ...rest } = config;
    await seedChat(testDb, chatId, { enabled, systemPrompt, model });

    // Build dynamic UPDATE for remaining config fields
    /** @type {string[]} */
    const setClauses = [];
    /** @type {unknown[]} */
    const values = [chatId];

    /** @param {string} col @param {unknown} val */
    const addCol = (col, val) => {
      values.push(val);
      setClauses.push(`${col} = $${values.length}`);
    };

    if (rest.debug != null) addCol("debug", rest.debug);
    if (rest.memory != null) addCol("memory", rest.memory);
    if (rest.memoryThreshold !== undefined) addCol("memory_threshold", rest.memoryThreshold);
    if (rest.respondOn != null) addCol("respond_on", rest.respondOn);
    if (rest.enabledActions != null) addCol("enabled_actions", JSON.stringify(rest.enabledActions));
    if (rest.persona !== undefined) addCol("active_persona", rest.persona);
    if (rest.modelRoles != null) addCol("model_roles", JSON.stringify(rest.modelRoles));
    if (rest.mediaToTextModels != null) addCol("media_to_text_models", JSON.stringify(rest.mediaToTextModels));

    if (setClauses.length > 0) {
      await testDb.query(
        `UPDATE chats SET ${setClauses.join(", ")} WHERE chat_id = $1`,
        values,
      );
    }

    return { send: makeSend(chatId) };
  }

  /**
   * @param {string} chatId
   * @returns {(input: string | MediaInput | {content: IncomingContentBlock[]}, options?: SendOptions) => Promise<SendResult>}
   */
  function makeSend(chatId) {
    return async (input, options) => {
      // 1. Parse input into content blocks
      /** @type {IncomingContentBlock[]} */
      let content;
      if (typeof input === "string") {
        content = [{ type: "text", text: input }];
      } else if ("content" in input) {
        content = input.content;
      } else if ("image" in input) {
        content = [
          { type: "image", encoding: "base64", mime_type: input.mime, data: input.image },
          ...(input.caption ? [/** @type {const} */ ({ type: "text", text: input.caption })] : []),
        ];
      } else if ("video" in input) {
        content = [
          { type: "video", encoding: "base64", mime_type: input.mime, data: input.video },
          ...(input.caption ? [/** @type {const} */ ({ type: "text", text: input.caption })] : []),
        ];
      } else {
        // audio
        content = [{ type: "audio", encoding: "base64", mime_type: input.mime, data: input.audio }];
      }

      // 2. Handle quote option
      /** @type {string | undefined} */
      let quotedSenderId;
      if (options?.quote) {
        content = [
          { type: "quote", content: [{ type: "text", text: options.quote.text }] },
          ...content,
        ];
        quotedSenderId = options.quote.senderId;
      }

      // 3. Queue LLM responses
      /** @type {{ clear: () => void } | undefined} */
      let scope;
      if (options?.llm) {
        scope = mockServer.addResponses(...options.llm);
      }

      // 4. Record request baseline
      const reqsBefore = mockServer.getRequests().length;

      // 5. Build and call context
      const sender = options?.sender;
      /** @type {ChatTurnOverrides} */
      const overrides = {
        chatId,
        content,
        facts: {
          isGroup: options?.isGroup ?? false,
          ...(quotedSenderId != null && { quotedSenderId }),
        },
      };
      if (sender) {
        overrides.senderIds = [sender.id ?? "master-user"];
        if (sender.name) overrides.senderName = sender.name;
      }

      const { context, responses } = createChatTurn(overrides);

      if (options?.confirm != null) {
        const userConfirm = options.confirm;
        context.io.confirm = async (msg) => {
          const result = typeof userConfirm === "function" ? userConfirm(msg) : userConfirm;
          responses.push({ type: "confirm", text: msg });
          return result;
        };
      }

      await handleMessage(context);

      // 6. Clean up scope
      scope?.clear();

      // 7. Build and return SendResult
      return {
        sends: responses.filter(r => r.type === "send").map(r => r.text),
        replies: responses.filter(r => r.type === "reply").map(r => r.text),
        all: responses.filter(r => r.type === "send" || r.type === "reply").map(r => r.text),
        reactions: responses.filter(r => r.type === "reactToMessage").map(r => r.text),
        confirms: responses.filter(r => r.type === "confirm").map(r => r.text),
        polls: responses.filter(r => r.type === "select").map(r => JSON.parse(r.text)),
        images: responses.filter(r => r.blockType === "image").map(r => r.text),
        videos: responses.filter(r => r.blockType === "video").map(r => r.text),
        presence: responses.filter(r => r.type === "sendPresenceUpdate").map(r => r.text),
        requests: mockServer.getRequests().slice(reqsBefore),
        raw: responses,
      };
    };
  }

  return { chat };
}

// ── Mock Baileys socket for e2e adapter tests ──

/**
 * @typedef {{
 *   chatId: string;
 *   msg: Record<string, unknown>;
 *   options?: Record<string, unknown>;
 * }} SentSocketMessage
 */

/**
 * @typedef {{
 *   sock: BaileysSocket;
 *   getSentMessages: () => SentSocketMessage[];
 *   getTextMessages: () => string[];
 *   getReactions: () => Array<{ text: string; key: Record<string, unknown> }>;
 *   getPresenceUpdates: () => Array<{ presence: string; chatId: string }>;
 *   emitReaction: (key: { id: string; remoteJid: string }, reaction: { text: string }) => void;
 *   clearCaptures: () => void;
 * }} MockBaileysSocket
 */

/**
 * Create a mock Baileys socket that captures all outgoing calls.
 *
 * @param {{
 *   selfId?: string;
 *   selfLid?: string;
 *   selfName?: string;
 *   isAdmin?: boolean;
 * }} [options]
 * @returns {MockBaileysSocket}
 */
export function createMockBaileysSocket(options = {}) {
  const {
    selfId = "bot-phone-id",
    selfLid = "bot-lid-id",
    selfName = "TestBot",
    isAdmin = false,
  } = options;

  const ee = new EventEmitter();

  /** @type {SentSocketMessage[]} */
  let sentMessages = [];
  /** @type {Array<{ text: string; key: Record<string, unknown> }>} */
  let reactions = [];
  /** @type {Array<{ presence: string; chatId: string }>} */
  let presenceUpdates = [];
  let msgCounter = 0;

  const sock = /** @type {BaileysSocket} */ (/** @type {unknown} */ ({
    user: { id: `${selfId}:0@s.whatsapp.net`, lid: `${selfLid}:0@lid`, name: selfName },
    ev: {
      on: ee.on.bind(ee),
      off: ee.removeListener.bind(ee),
      listenerCount: ee.listenerCount.bind(ee),
    },
    /** @param {string} chatId @param {Record<string, unknown>} msg @param {Record<string, unknown>} [opts] */
    sendMessage: async (chatId, msg, opts) => {
      if (msg.react) {
        reactions.push({ text: /** @type {{ text: string }} */ (msg.react).text, key: /** @type {{ key: Record<string, unknown> }} */ (msg.react).key ?? {} });
        return null;
      }
      const key = { id: `sent-msg-${msgCounter++}`, remoteJid: chatId };
      sentMessages.push({ chatId, msg, options: opts });
      return { key };
    },
    /** @param {string} presence @param {string} chatId */
    sendPresenceUpdate: async (presence, chatId) => {
      presenceUpdates.push({ presence, chatId });
    },
    /** @param {string} _chatId */
    groupMetadata: async (_chatId) => ({
      participants: isAdmin
        ? [{ id: `${selfId}@s.whatsapp.net`, admin: "admin" }]
        : [],
    }),
  }));

  return {
    sock,
    getSentMessages: () => sentMessages,
    getTextMessages: () => sentMessages
      .filter(m => typeof m.msg.text === "string")
      .map(m => /** @type {string} */ (m.msg.text)),
    getReactions: () => reactions,
    getPresenceUpdates: () => presenceUpdates,
    emitReaction: (key, reaction) => {
      ee.emit("messages.reaction", [{ key, reaction }]);
    },
    clearCaptures: () => {
      sentMessages = [];
      reactions = [];
      presenceUpdates = [];
    },
  };
}

// ── WAMessage factory for e2e adapter tests ──

/**
 * Build a realistic Baileys WAMessage for testing.
 *
 * @param {{
 *   text?: string;
 *   chatId?: string;
 *   senderId?: string;
 *   senderLid?: string;
 *   senderName?: string;
 *   isGroup?: boolean;
 *   timestamp?: number;
 *   image?: { mimetype: string; caption?: string };
 *   video?: { mimetype: string; caption?: string };
 *   audio?: { mimetype: string };
 *   quotedText?: string;
 *   quotedSenderId?: string;
 * }} [options]
 * @returns {BaileysMessage}
 */
export function createWAMessage(options = {}) {
  const {
    text,
    chatId: rawChatId,
    senderId = "master-user",
    senderLid = "sender-lid",
    senderName = "Test User",
    isGroup = false,
    timestamp = Math.floor(Date.now() / 1000),
    image,
    video,
    audio,
    quotedText,
    quotedSenderId,
  } = options;

  const chatId = rawChatId ?? (isGroup ? "group-chat@g.us" : `${senderId}@s.whatsapp.net`);

  /** @type {Record<string, unknown>} */
  const key = {
    remoteJid: chatId,
    fromMe: false,
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  };

  if (isGroup) {
    key.participant = `${senderId}@s.whatsapp.net`;
    key.participantLid = `${senderLid}@lid`;
  } else {
    key.senderLid = `${senderLid}@lid`;
  }

  /** @type {Record<string, unknown>} */
  let message = {};

  // Build contextInfo for quotes
  /** @type {Record<string, unknown> | undefined} */
  let contextInfo;
  if (quotedText) {
    contextInfo = {
      quotedMessage: { conversation: quotedText },
    };
    if (quotedSenderId) {
      contextInfo.participant = `${quotedSenderId}@s.whatsapp.net`;
    }
  }

  if (image) {
    message.imageMessage = {
      mimetype: image.mimetype,
      ...(image.caption && { caption: image.caption }),
      url: "https://mock/image",
      ...(contextInfo && { contextInfo }),
    };
  } else if (video) {
    message.videoMessage = {
      mimetype: video.mimetype,
      ...(video.caption && { caption: video.caption }),
      url: "https://mock/video",
      ...(contextInfo && { contextInfo }),
    };
  } else if (audio) {
    message.audioMessage = {
      mimetype: audio.mimetype,
      url: "https://mock/audio",
      ...(contextInfo && { contextInfo }),
    };
  } else if (contextInfo) {
    // Text with quote → extendedTextMessage
    message.extendedTextMessage = {
      text: text ?? "",
      contextInfo,
    };
  } else if (text !== undefined) {
    message.conversation = text;
  }

  return /** @type {BaileysMessage} */ (/** @type {unknown} */ ({
    key,
    message,
    messageTimestamp: timestamp,
    pushName: senderName,
  }));
}
