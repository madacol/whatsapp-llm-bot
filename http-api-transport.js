import { createServer } from "node:http";
import { createLogger } from "./logger.js";
import { createHttpApiTurnFlow } from "./http-api-turn-flow.js";
import { createHttpApiTurnIntake } from "./http-api-turn-intake.js";
import { mediaPathToMimeType, readMediaBuffer, validateMediaPath, writeMedia } from "./media-store.js";
import { synthesizeSpeechForHttpApi } from "./http-api-speech.js";

const log = createLogger("http-api-transport");
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_MAX_EVENTS = 1000;
const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const CORS_ALLOWED_HEADERS = "authorization,content-type,last-event-id,x-request-id,x-chat-id,x-sender-id,x-sender-name,x-timestamp";

/**
 * @typedef {{
 *   eventId: string;
 *   turnId: string | null;
 *   chatId: string;
 *   kind: OutboundEvent["kind"];
 *   event: OutboundEvent;
 * }} HttpApiOutboundEvent
 *
 * @typedef {{
 *   turnId: string;
 *   requestId: string;
 *   transportId: string;
 *   chatId: string;
 *   status: "accepted" | "running" | "completed" | "failed" | "cancelled";
 *   createdAt: string;
 *   updatedAt: string;
 *   text: string;
 * }} HttpApiTurnRecord
 *
 * @typedef {{
 *   requestId: string;
 *   chatId: string;
 *   senderIds: string[];
 *   senderName: string;
 *   timestamp: Date;
 *   content: [TextContentBlock] | [AudioContentBlock];
 *   facts: ChannelInputFacts;
 * }} HttpApiTurnPayload
 *
 * @typedef {{
 *   text: string;
 *   chatId: string;
 *   turnId: string;
 * }} HttpApiSpeechSynthesisInput
 *
 * @typedef {{
 *   buffer: Buffer;
 *   mimeType: string;
 * }} HttpApiSpeechSynthesisResult
 *
 * @typedef {{
 *   path: string;
 *   mimeType: string;
 *   url: string;
 * }} HttpApiAudioResponse
 *
 * @typedef {{
 *   chain: Promise<void>;
 *   lastAudio: HttpApiAudioResponse | null;
 * }} HttpApiTurnSpeechState
 *
 * @typedef {{
 *   port?: number;
 *   host?: string;
 *   authToken?: string;
 *   maxEvents?: number;
 *   maxAudioBytes?: number;
 *   synthesizeSpeech?: (input: HttpApiSpeechSynthesisInput) => Promise<HttpApiSpeechSynthesisResult | null | undefined>;
 * }} HttpApiTransportOptions
 *
 * @typedef {ChatTransport & {
 *   readonly baseUrl: string;
 *   readonly port: number | null;
 * }} HttpApiTransport
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeSenderIds(value) {
  if (!Array.isArray(value)) {
    return ["api-user"];
  }
  const ids = value
    .filter((entry) => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim());
  return ids.length > 0 ? ids : ["api-user"];
}

/**
 * @param {unknown} value
 * @returns {Date}
 */
function normalizeTimestamp(value) {
  if (typeof value !== "string") {
    return new Date();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

/**
 * @param {unknown} value
 * @returns {ChannelInputFacts}
 */
function normalizeFacts(value) {
  if (!isRecord(value)) {
    return {
      isGroup: false,
      addressedToBot: true,
      repliedToBot: false,
    };
  }
  return {
    isGroup: value.isGroup === true,
    addressedToBot: value.addressedToBot !== false,
    repliedToBot: value.repliedToBot === true,
  };
}

/**
 * @param {unknown} value
 * @returns {TextContentBlock | null}
 */
function getSingleTextBlock(value) {
  if (!Array.isArray(value) || value.length !== 1) {
    return null;
  }
  const block = value[0];
  if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string" || block.text.trim().length === 0) {
    return null;
  }
  return { type: "text", text: block.text };
}

/**
 * @param {import("node:http").ServerResponse} res
 * @param {number} statusCode
 * @param {unknown} payload
 * @returns {void}
 */
function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": CORS_ALLOWED_HEADERS,
    "content-type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(payload));
}

/**
 * @param {import("node:http").ServerResponse} res
 * @returns {void}
 */
function sendNoContent(res) {
  res.writeHead(204, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": CORS_ALLOWED_HEADERS,
  });
  res.end();
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
async function readBody(req, maxBytes) {
  /** @type {Buffer[]} */
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBytes) {
      throw new Error("Request body is too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @returns {Promise<unknown>}
 */
async function readJsonBody(req) {
  const body = await readBody(req, MAX_BODY_BYTES);
  const raw = body.toString("utf8");
  if (!raw.trim()) {
    return null;
  }
  return JSON.parse(raw);
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
async function readBinaryBody(req, maxBytes) {
  return readBody(req, maxBytes);
}

/**
 * @param {string} encoded
 * @returns {string | null}
 */
function decodePathPart(encoded) {
  try {
    const decoded = decodeURIComponent(encoded);
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * @param {string | null} value
 * @returns {number}
 */
function parseCursor(value) {
  if (!value) {
    return 0;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * @param {unknown} body
 * @returns {HttpApiTurnPayload | null}
 */
function normalizeTurnPayload(body) {
  if (!isRecord(body)) {
    return null;
  }
  const requestId = nonEmptyString(body.requestId);
  const chatId = nonEmptyString(body.chatId);
  const textBlock = getSingleTextBlock(body.content);
  if (!requestId || !chatId || !textBlock) {
    return null;
  }
  const senderIds = normalizeSenderIds(body.senderIds);
  return {
    requestId,
    chatId,
    senderIds,
    senderName: nonEmptyString(body.senderName) ?? senderIds[0] ?? "api-user",
    timestamp: normalizeTimestamp(body.timestamp),
    content: [textBlock],
    facts: normalizeFacts(body.facts),
  };
}

/**
 * @param {import("node:http").IncomingHttpHeaders} headers
 * @param {URLSearchParams} searchParams
 * @param {string} name
 * @returns {string | null}
 */
function metadataString(headers, searchParams, name) {
  return nonEmptyString(headers[`x-${name}`]) ?? nonEmptyString(searchParams.get(name));
}

/**
 * @param {string | string[] | undefined} value
 * @returns {string | null}
 */
function contentTypeHeader(value) {
  if (Array.isArray(value)) {
    return nonEmptyString(value[0]);
  }
  return nonEmptyString(value);
}

/**
 * @param {import("node:http").IncomingHttpHeaders} headers
 * @param {URLSearchParams} searchParams
 * @param {AudioContentBlock} audioBlock
 * @returns {HttpApiTurnPayload | null}
 */
function normalizeAudioTurnPayload(headers, searchParams, audioBlock) {
  const requestId = metadataString(headers, searchParams, "request-id");
  const chatId = metadataString(headers, searchParams, "chat-id");
  if (!requestId || !chatId) {
    return null;
  }
  const senderId = metadataString(headers, searchParams, "sender-id") ?? "api-user";
  return {
    requestId,
    chatId,
    senderIds: [senderId],
    senderName: metadataString(headers, searchParams, "sender-name") ?? senderId,
    timestamp: normalizeTimestamp(metadataString(headers, searchParams, "timestamp")),
    content: [audioBlock],
    facts: {
      isGroup: false,
      addressedToBot: true,
      repliedToBot: false,
    },
  };
}

/**
 * @param {string} baseUrl
 * @param {string} mediaPath
 * @param {string} mimeType
 * @returns {{ path: string, mimeType: string, url: string }}
 */
function buildAudioResponse(baseUrl, mediaPath, mimeType) {
  return {
    path: mediaPath,
    mimeType,
    url: `${baseUrl}/api/media/${encodeURIComponent(mediaPath)}`,
  };
}

/**
 * @param {SendContent} content
 * @returns {string}
 */
function extractTextContent(content) {
  if (typeof content === "string") {
    return isTransientAssistantStatus(content) ? "" : content;
  }
  const blocks = Array.isArray(content) ? content : [content];
  return blocks
    .map((block) => {
      if ((block.type === "text" || block.type === "markdown") && typeof block.text === "string") {
        return isTransientAssistantStatus(block.text) ? "" : block.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function isTransientAssistantStatus(text) {
  return text.trim() === "Thinking...";
}

/**
 * @param {OutboundEvent} event
 * @returns {string}
 */
function assistantOutputText(event) {
  if (event.kind !== "assistant_output") {
    return "";
  }
  return extractTextContent(event.content).trim();
}

/**
 * Create a simple HTTP API transport for non-WhatsApp clients.
 *
 * @param {HttpApiTransportOptions} [options]
 * @returns {Promise<HttpApiTransport>}
 */
export async function createHttpApiTransport(options = {}) {
  const host = options.host ?? DEFAULT_HOST;
  const requestedPort = options.port ?? 0;
  const authToken = options.authToken ?? "";
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  const maxAudioBytes = options.maxAudioBytes ?? DEFAULT_MAX_AUDIO_BYTES;
  const synthesizeSpeech = options.synthesizeSpeech ?? synthesizeSpeechForHttpApi;
  /** @type {Map<string, HttpApiTurnSpeechState>} */
  const speechByTurnId = new Map();
  /** @type {Set<string>} */
  const speechEnabledTurnIds = new Set();
  /** @type {(input: ChannelInput) => Promise<void>} */
  let onTurn = async () => {};
  /** @type {import("node:http").Server | null} */
  let server = null;
  /** @type {number | null} */
  let assignedPort = null;
  let started = false;
  const turnFlow = createHttpApiTurnFlow({
    maxEvents,
    onEvent: (row) => {
      queueSpeechForAssistantOutput(row);
    },
  });
  const turnIntake = createHttpApiTurnIntake({
    turnFlow,
    getBaseUrl: () => transport.baseUrl,
    log,
  });

  /**
   * @param {string} turnId
   * @returns {HttpApiTurnSpeechState}
   */
  function getTurnSpeechState(turnId) {
    let state = speechByTurnId.get(turnId);
    if (!state) {
      state = {
        chain: Promise.resolve(),
        lastAudio: null,
      };
      speechByTurnId.set(turnId, state);
    }
    return state;
  }

  /**
   * @param {HttpApiOutboundEvent} row
   * @returns {void}
   */
  function queueSpeechForAssistantOutput(row) {
    const turnId = row.turnId;
    if (!turnId) {
      return;
    }
    if (!speechEnabledTurnIds.has(turnId)) {
      return;
    }
    const text = assistantOutputText(row.event);
    if (!text) {
      return;
    }
    const state = getTurnSpeechState(turnId);
    state.chain = state.chain.then(async () => {
      let speech;
      try {
        speech = await synthesizeSpeech({
          text,
          chatId: row.chatId,
          turnId,
        });
      } catch (error) {
        log.warn("HTTP API speech synthesis failed for assistant event.", error);
        return;
      }
      if (!speech?.buffer?.byteLength || !speech.mimeType) {
        return;
      }
      const outputPath = await writeMedia(speech.buffer, speech.mimeType, "audio");
      const audioResponse = buildAudioResponse(transport.baseUrl, outputPath, speech.mimeType);
      state.lastAudio = audioResponse;
      turnFlow.appendEvent(row.chatId, {
        kind: "assistant_output",
        content: [{
          type: /** @type {const} */ ("audio"),
          path: outputPath,
          mime_type: speech.mimeType,
        }],
      }, turnId);
    }).catch((error) => {
      log.warn("HTTP API queued speech synthesis failed.", error);
    });
  }

  /**
   * @param {string} turnId
   * @returns {Promise<HttpApiAudioResponse | null>}
   */
  async function waitForTurnSpeech(turnId) {
    const state = speechByTurnId.get(turnId);
    if (!state) {
      return null;
    }
    await state.chain;
    speechByTurnId.delete(turnId);
    return state.lastAudio;
  }

  /**
   * @param {import("node:http").IncomingMessage} req
   * @returns {boolean}
   */
  function isAuthorized(req) {
    if (!authToken) {
      return true;
    }
    return req.headers.authorization === `Bearer ${authToken}`;
  }

  /**
   * @param {string} chatId
   * @param {OutboundEvent} event
   * @param {string | null} turnId
   * @returns {HttpApiOutboundEvent}
   */
  function appendEvent(chatId, event, turnId) {
    return turnFlow.appendEvent(chatId, event, turnId);
  }

  /**
   * @param {string} chatId
   * @param {number} after
   * @returns {HttpApiOutboundEvent[]}
   */
  function listEvents(chatId, after) {
    return turnFlow.listEvents(chatId, after);
  }

  /**
   * @param {import("node:http").IncomingMessage} req
   * @param {import("node:http").ServerResponse} res
   * @param {string} transportId
   * @param {boolean} waitForCompletion
   * @returns {Promise<void>}
   */
  async function handleSubmitTurn(req, res, transportId, waitForCompletion) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: "Expected valid JSON body" });
      return;
    }

    const payload = normalizeTurnPayload(body);
    if (!payload) {
      sendJson(res, 400, {
        error: "Expected text turn payload with requestId, chatId, and one text content block",
      });
      return;
    }

    const response = await turnIntake.submitTurn({
      transportId,
      payload,
      waitForCompletion,
      runTurn: onTurn,
    });
    sendJson(res, response.statusCode, response.body);
  }

  /**
   * @param {import("node:http").IncomingMessage} req
   * @param {import("node:http").ServerResponse} res
   * @param {string} transportId
   * @param {URLSearchParams} searchParams
   * @param {boolean} waitForCompletion
   * @returns {Promise<void>}
   */
  async function handleSubmitAudioTurn(req, res, transportId, searchParams, waitForCompletion) {
    const mimeType = contentTypeHeader(req.headers["content-type"]);
    if (!mimeType || !mimeType.toLowerCase().startsWith("audio/")) {
      sendJson(res, 400, { error: "Expected audio request body with an audio/* content-type" });
      return;
    }
    if (!metadataString(req.headers, searchParams, "request-id") || !metadataString(req.headers, searchParams, "chat-id")) {
      sendJson(res, 400, { error: "Expected x-request-id and x-chat-id headers for audio turns" });
      return;
    }

    let body;
    try {
      body = await readBinaryBody(req, maxAudioBytes);
    } catch {
      sendJson(res, 400, { error: "Audio request body is too large" });
      return;
    }
    if (body.byteLength === 0) {
      sendJson(res, 400, { error: "Expected non-empty audio request body" });
      return;
    }

    const mediaPath = await writeMedia(body, mimeType, "audio");
    const payload = normalizeAudioTurnPayload(req.headers, searchParams, {
      type: "audio",
      path: mediaPath,
      mime_type: mimeType,
    });
    if (!payload) {
      sendJson(res, 400, { error: "Expected x-request-id and x-chat-id headers for audio turns" });
      return;
    }

    const response = await turnIntake.submitTurn({
      transportId,
      payload,
      waitForCompletion,
      runTurn: onTurn,
      onTurnCreated: ({ record }) => {
        speechEnabledTurnIds.add(record.turnId);
      },
      afterTurnCompleted: async ({ record }) => {
        try {
          const audio = await waitForTurnSpeech(record.turnId);
          return audio ? { audio } : null;
        } finally {
          speechEnabledTurnIds.delete(record.turnId);
        }
      },
    });
    sendJson(res, response.statusCode, response.body);
  }

  /**
   * @param {import("node:http").ServerResponse} res
   * @param {string} encodedMediaPath
   * @returns {Promise<void>}
   */
  async function handleMediaDownload(res, encodedMediaPath) {
    const mediaPath = decodePathPart(encodedMediaPath);
    if (!mediaPath) {
      sendJson(res, 400, { error: "Invalid media path" });
      return;
    }
    try {
      const validatedPath = validateMediaPath(mediaPath);
      const buffer = await readMediaBuffer(validatedPath);
      res.writeHead(200, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": CORS_ALLOWED_HEADERS,
        "content-length": String(buffer.byteLength),
        "content-type": mediaPathToMimeType(validatedPath, undefined),
      });
      res.end(buffer);
    } catch {
      sendJson(res, 404, { error: "Media not found" });
    }
  }

  /**
   * @param {import("node:http").ServerResponse} res
   * @param {string} chatId
   * @param {number} after
   * @returns {void}
   */
  function handleEventStream(res, chatId, after) {
    res.writeHead(200, {
      "access-control-allow-origin": "*",
      "cache-control": "no-cache",
      "connection": "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
    });
    res.flushHeaders?.();
    const client = turnFlow.openEventStream(chatId, after, {
      write: (row) => {
        res.write(`id: ${row.eventId}\n`);
        res.write(`data: ${JSON.stringify(row)}\n\n`);
      },
      close: () => {
        res.end();
      },
    });
    res.on("close", () => {
      turnFlow.closeEventStream(client);
    });
  }

  /**
   * @param {import("node:http").IncomingMessage} req
   * @param {import("node:http").ServerResponse} res
   * @returns {Promise<void>}
   */
  async function handleRequest(req, res) {
    if (req.method === "OPTIONS") {
      sendNoContent(res);
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== "/health" && !isAuthorized(req)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    const submitMatch = url.pathname.match(/^\/api\/transports\/([^/]+)\/turns$/);
    if (req.method === "POST" && submitMatch) {
      const transportId = decodePathPart(submitMatch[1] ?? "");
      if (!transportId) {
        sendJson(res, 400, { error: "Invalid transport id" });
        return;
      }
      await handleSubmitTurn(req, res, transportId, url.searchParams.get("wait") === "true");
      return;
    }

    const audioSubmitMatch = url.pathname.match(/^\/api\/transports\/([^/]+)\/audio-turns$/);
    if (req.method === "POST" && audioSubmitMatch) {
      const transportId = decodePathPart(audioSubmitMatch[1] ?? "");
      if (!transportId) {
        sendJson(res, 400, { error: "Invalid transport id" });
        return;
      }
      await handleSubmitAudioTurn(req, res, transportId, url.searchParams, url.searchParams.get("wait") === "true");
      return;
    }

    const mediaMatch = url.pathname.match(/^\/api\/media\/([^/]+)$/);
    if (req.method === "GET" && mediaMatch) {
      await handleMediaDownload(res, mediaMatch[1] ?? "");
      return;
    }

    const statusMatch = url.pathname.match(/^\/api\/transports\/([^/]+)\/turns\/([^/]+)$/);
    if (req.method === "GET" && statusMatch) {
      const transportId = decodePathPart(statusMatch[1] ?? "");
      const turnId = decodePathPart(statusMatch[2] ?? "");
      const turn = turnId ? turnFlow.getTurn(turnId) : null;
      if (!transportId || !turn || turn.transportId !== transportId) {
        sendJson(res, 404, { error: "Turn not found" });
        return;
      }
      sendJson(res, 200, {
        turnId: turn.turnId,
        requestId: turn.requestId,
        chatId: turn.chatId,
        status: turn.status,
        createdAt: turn.createdAt,
        updatedAt: turn.updatedAt,
      });
      return;
    }

    const eventsMatch = url.pathname.match(/^\/api\/transports\/([^/]+)\/events$/);
    if (req.method === "GET" && eventsMatch) {
      const chatId = nonEmptyString(url.searchParams.get("chatId"));
      if (!chatId) {
        sendJson(res, 400, { error: "Expected chatId query parameter" });
        return;
      }
      const rows = listEvents(chatId, parseCursor(url.searchParams.get("after") ?? req.headers["last-event-id"]?.toString() ?? null));
      sendJson(res, 200, {
        events: rows,
        nextEventId: turnFlow.getLastEventId(),
      });
      return;
    }

    const streamMatch = url.pathname.match(/^\/api\/transports\/([^/]+)\/events\/stream$/);
    if (req.method === "GET" && streamMatch) {
      const chatId = nonEmptyString(url.searchParams.get("chatId"));
      if (!chatId) {
        sendJson(res, 400, { error: "Expected chatId query parameter" });
        return;
      }
      handleEventStream(res, chatId, parseCursor(url.searchParams.get("after") ?? req.headers["last-event-id"]?.toString() ?? null));
      return;
    }

    sendJson(res, 404, { error: "Not Found" });
  }

  /** @type {HttpApiTransport} */
  const transport = {
    get baseUrl() {
      return assignedPort === null ? "" : `http://${host}:${assignedPort}`;
    },
    get port() {
      return assignedPort;
    },
    async start(turnHandler) {
      if (started) {
        onTurn = turnHandler;
        return;
      }
      onTurn = turnHandler;
      server = createServer((req, res) => {
        void handleRequest(req, res).catch((error) => {
          log.error("HTTP API transport request failed:", error);
          if (!res.headersSent) {
            sendJson(res, 500, { error: "Internal Server Error" });
          } else {
            res.end();
          }
        });
      });
      const activeServer = server;
      await new Promise((resolve) => activeServer.listen(requestedPort, host, () => resolve(undefined)));
      const addr = activeServer.address();
      assignedPort = typeof addr === "object" && addr ? addr.port : requestedPort;
      started = true;
      log.info(`listening on ${host}:${assignedPort}`);
    },
    async stop() {
      onTurn = async () => {};
      started = false;
      turnFlow.closeEventStreams();
      const activeServer = server;
      server = null;
      assignedPort = null;
      if (activeServer) {
        await new Promise((resolve) => activeServer.close(() => resolve(undefined)));
      }
    },
    async sendText(chatId, text) {
      if (!started) {
        throw new Error("HTTP API transport has not been started");
      }
      appendEvent(chatId, {
        kind: "app_message",
        role: "plain",
        content: text,
      }, turnFlow.getActiveTurnId(chatId));
    },
    async sendEvent(chatId, event) {
      if (!started) {
        throw new Error("HTTP API transport has not been started");
      }
      appendEvent(chatId, event, turnFlow.getActiveTurnId(chatId));
      return undefined;
    },
  };

  return transport;
}
