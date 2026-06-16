import { generateMessageIDV2, generateWAMessage, generateWAMessageFromContent, proto } from "@whiskeysockets/baileys";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../../logger.js";
import { parseToolArgs } from "../../agent-io-defaults.js";
import { buildContextualUnifiedDiff } from "../../code-image-renderer.js";
import { getDefaultRuntimeDiagnosticsState } from "../../diagnostics-config.js";
import { renderBlocks } from "../../message-renderer.js";
import { formatPlanPresentationText } from "../../plan-presentation.js";
import { formatToolFlowInspectText, formatToolFlowSummary } from "../tool-flow-presenter.js";
import { buildToolPresentation, shortenPath } from "../tool-presentation-model.js";
import { formatUsageEventText } from "../../usage-formatting.js";
import { makeImageMessage, makeTextMessage } from "../message-payloads.js";
import {
  formatToolPresentationInspect,
  formatToolPresentationSummary,
  langFromPath,
  renderToolActivityContent,
  renderToolPresentationContent,
} from "../tool-presenter.js";
import { sendImageHD } from "../../whatsapp-hd-media.js";

/** Delay between relaying each image in an album so WhatsApp groups them. */
const ALBUM_RELAY_DELAY_MS = 500;
const SNAPSHOT_DIFF_LINES_PER_BATCH = 1000;
const SNAPSHOT_DIFF_CONTINUATION_TIMEOUT_MS = 30 * 60 * 1000;
const WHATSAPP_EDIT_HANDLE_TTL_MS = 14 * 60 * 1000;
const DEFAULT_WHATSAPP_EDIT_DEBOUNCE_MS = 1000;
const TURN_STATUS_PIN_SECONDS = 86400;
const INSPECT_REACTION_EMOJI = "👁";
const log = createLogger("whatsapp:outbound");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const WHATSAPP_OUTBOUND_DIAGNOSTIC_DEFAULT_PATH = path.join(REPO_ROOT, "logs", "whatsapp-outbound.jsonl");
/** @type {Map<string, WhatsAppEditHandleRecord>} */
const inMemoryEditHandles = new Map();
/** @type {Map<string, {
 *   sock: import('@whiskeysockets/baileys').WASocket,
 *   text: string,
 *   options: { store?: import("../../store.js").Store },
 *   timer: ReturnType<typeof setTimeout>,
 *   waiters: Array<{ resolve: () => void, reject: (error: unknown) => void }>,
 * }>} */
const pendingEditDebounces = new Map();
/** @type {Map<string, { handle?: MessageHandle, entries: Array<{ key: string, icon: string, provider: string, summary: string }> }>} */
const turnStatusByChat = new Map();
/** @type {Map<string, { handle?: MessageHandle, entries: Array<{ icon: string, provider: string, summary: string, detail?: string }> }>} */
const runtimeStatusByChat = new Map();
/** @type {Map<string, Map<string, { handle?: MessageHandle, command: string, reviewPrefix?: "👍" | "👎" }>>} */
const runtimeCommandsByChat = new Map();
/** @type {Map<string, Map<string, { handle?: MessageHandle, summary: string, reviewPrefix?: "👍" | "👎" }>>} */
const runtimeToolsByChat = new Map();
/** @type {Map<string, {
 *   handle?: MessageHandle,
 *   entries: Array<{ id: string, summary: string, inspectDetail?: string, completed: boolean, failed: boolean, reviewPrefix?: "👍" | "👎" }>,
 *   pendingCommandEntryIds: Map<string, string[]>,
 *   pendingToolEntryIds: string[],
 *   pendingToolEntryIdsByToolId: Map<string, string>,
 *   debounceTimer: ReturnType<typeof setTimeout> | null,
 *   nextEntryId: number,
 * }>} */
const compactToolActivityByChat = new Map();

const COMPACT_TOOL_ACTIVITY_LIMIT = 3;
const COMPACT_TOOL_ACTIVITY_DEBOUNCE_MS = 1000;

/**
 * @returns {number}
 */
function getWhatsAppEditDebounceMs() {
  const raw = process.env.MADABOT_WHATSAPP_EDIT_DEBOUNCE_MS;
  if (raw === undefined || raw.trim() === "") {
    return process.env.TESTING === "1" ? 0 : DEFAULT_WHATSAPP_EDIT_DEBOUNCE_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_WHATSAPP_EDIT_DEBOUNCE_MS;
}

/**
 * @typedef {{
 *   type: "status.created" | "status.edited" | "pin.succeeded" | "pin.failed" | "pin.skipped" | "unpin.succeeded" | "unpin.failed" | "unpin.skipped";
 *   chatId: string;
 *   messageId?: string;
 *   firstLine?: string;
 *   text?: string;
 *   error?: string;
 * }} PinnedStatusDeliveryEvent
 *
 * @typedef {(event: PinnedStatusDeliveryEvent) => void} PinnedStatusDeliveryObserver
 */

/** @type {Record<MessageSource, string>} */
const SOURCE_PREFIX = {
  llm: "🤖",
  "tool-call": "🔧",
  "tool-result": "✅",
  error: "❌",
  warning: "⚠️",
  usage: "📊",
  memory: "🧠",
  plain: "",
};

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {import('@whiskeysockets/baileys').WAMessageKey | undefined | null} key
 * @returns {Record<string, unknown> | null}
 */
function summarizeDiagnosticMessageKey(key) {
  if (!key) {
    return null;
  }
  return {
    id: key.id ?? null,
    remoteJid: key.remoteJid ?? null,
    fromMe: key.fromMe ?? null,
    participant: key.participant ?? null,
  };
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function diagnosticByteLength(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return value.byteLength;
  }
  return null;
}

/**
 * @param {Record<string, unknown> | undefined} options
 * @returns {Record<string, unknown> | null}
 */
function summarizeOutboundOptions(options) {
  if (!options) {
    return null;
  }
  const quoted = isRecord(options.quoted) ? options.quoted : null;
  const quotedKey = isRecord(quoted?.key)
    ? /** @type {import('@whiskeysockets/baileys').WAMessageKey} */ (quoted.key)
    : undefined;
  return {
    hasQuoted: !!quoted,
    quotedKey: summarizeDiagnosticMessageKey(quotedKey),
  };
}

/**
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @returns {string[]}
 */
function getSocketSelfIds(sock) {
  const ids = [sock.user?.id, sock.user?.lid]
    .filter((id) => typeof id === "string" && id.length > 0)
    .map((id) => /** @type {string} */ (id).split(":")[0].split("@")[0]);
  return [...new Set(ids)];
}

/**
 * @param {string} senderId
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @returns {boolean}
 */
function isReactionFromSelf(senderId, sock) {
  const normalizedSenderId = senderId.split(":")[0].split("@")[0];
  return getSocketSelfIds(sock).includes(normalizedSenderId);
}

/**
 * @param {any} msg
 * @returns {Record<string, unknown>}
 */
export function buildWhatsAppOutboundMessageDiagnostic(msg) {
  if (typeof msg.text === "string") {
    return {
      kind: msg.edit ? "text_edit" : "text",
      text: msg.text,
      textLength: msg.text.length,
      edit: summarizeDiagnosticMessageKey(
        isRecord(msg.edit) ? /** @type {import('@whiskeysockets/baileys').WAMessageKey} */ (msg.edit) : undefined,
      ),
    };
  }
  if (isRecord(msg.react)) {
    return {
      kind: "reaction",
      emoji: typeof msg.react.text === "string" ? msg.react.text : null,
      targetKey: summarizeDiagnosticMessageKey(
        isRecord(msg.react.key) ? /** @type {import('@whiskeysockets/baileys').WAMessageKey} */ (msg.react.key) : undefined,
      ),
    };
  }
  if (isRecord(msg.pin)) {
    return {
      kind: "pin",
      targetKey: summarizeDiagnosticMessageKey(
        /** @type {import('@whiskeysockets/baileys').WAMessageKey} */ (msg.pin),
      ),
      type: msg.type ?? null,
      time: msg.time ?? null,
    };
  }
  if (isRecord(msg.delete)) {
    return {
      kind: "delete",
      targetKey: summarizeDiagnosticMessageKey(
        /** @type {import('@whiskeysockets/baileys').WAMessageKey} */ (msg.delete),
      ),
    };
  }
  if (msg.image) {
    return {
      kind: "image",
      caption: typeof msg.caption === "string" ? msg.caption : null,
      mediaBytes: diagnosticByteLength(msg.image),
    };
  }
  if (msg.video) {
    return {
      kind: "video",
      caption: typeof msg.caption === "string" ? msg.caption : null,
      mimetype: typeof msg.mimetype === "string" ? msg.mimetype : null,
      mediaBytes: diagnosticByteLength(msg.video),
    };
  }
  if (msg.audio) {
    return {
      kind: "audio",
      mimetype: typeof msg.mimetype === "string" ? msg.mimetype : null,
      mediaBytes: diagnosticByteLength(msg.audio),
    };
  }
  if (msg.document) {
    return {
      kind: "document",
      caption: typeof msg.caption === "string" ? msg.caption : null,
      mimetype: typeof msg.mimetype === "string" ? msg.mimetype : null,
      fileName: typeof msg.fileName === "string" ? msg.fileName : null,
      mediaBytes: diagnosticByteLength(msg.document),
    };
  }
  if (isRecord(msg.protocolMessage)) {
    const protocolMessage = msg.protocolMessage;
    const editedMessage = isRecord(protocolMessage.editedMessage) ? protocolMessage.editedMessage : null;
    const editedImageMessage = isRecord(editedMessage?.imageMessage) ? editedMessage.imageMessage : null;
    return {
      kind: "protocol",
      protocolType: protocolMessage.type ?? null,
      key: summarizeDiagnosticMessageKey(
        isRecord(protocolMessage.key)
          ? /** @type {import('@whiskeysockets/baileys').WAMessageKey} */ (protocolMessage.key)
          : undefined,
      ),
      editedImageCaption: typeof editedImageMessage?.caption === "string" ? editedImageMessage.caption : null,
    };
  }
  return {
    kind: "unknown",
    messageKeys: Object.keys(msg),
  };
}

/**
 * @param {{
 *   transport: "sendMessage" | "relayMessage" | "messageHandle";
 *   phase: "attempt" | "sent" | "failed" | "queued" | "replaced" | "flushing" | "immediate" | "attached" | "handled" | "ignored";
 *   chatId: string;
 *   message: Record<string, unknown>;
 *   resultKey?: import('@whiskeysockets/baileys').WAMessageKey | null;
 *   options?: Record<string, unknown>;
 *   error?: string;
 *   trace?: Record<string, unknown>;
 * }} event
 * @param {{
 *   diagnosticsState?: import("../../diagnostics-config.js").RuntimeDiagnosticsState,
 *   targetPath?: string,
 * }} [options]
 * @returns {void}
 */
export function appendWhatsAppOutboundDiagnostic(event, options = {}) {
  const diagnosticsState = options.diagnosticsState ?? getDefaultRuntimeDiagnosticsState();
  if (!diagnosticsState.isWhatsAppOutboundLogEnabled()) {
    return;
  }
  const targetPath = options.targetPath ?? WHATSAPP_OUTBOUND_DIAGNOSTIC_DEFAULT_PATH;
  mkdirSync(path.dirname(targetPath), { recursive: true });
  appendFileSync(targetPath, `${JSON.stringify({
    observedAt: new Date().toISOString(),
    transport: event.transport,
    phase: event.phase,
    chatId: event.chatId,
    message: buildWhatsAppOutboundMessageDiagnostic(event.message),
    resultKey: summarizeDiagnosticMessageKey(event.resultKey),
    options: summarizeOutboundOptions(event.options),
    ...(event.trace ? { trace: event.trace } : {}),
    ...(event.error ? { error: event.error } : {}),
  })}\n`);
}

/**
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} chatId
 * @param {any} msg
 * @param {Record<string, unknown> | undefined} options
 * @returns {Promise<import('@whiskeysockets/baileys').WAMessage | undefined>}
 */
async function sendObservedWhatsAppMessage(sock, chatId, msg, options) {
  const diagnosticMessage = /** @type {Record<string, unknown>} */ (msg);
  appendWhatsAppOutboundDiagnostic({ transport: "sendMessage", phase: "attempt", chatId, message: diagnosticMessage, options });
  try {
    const sent = await sock.sendMessage(chatId, /** @type {any} */ (msg), options);
    appendWhatsAppOutboundDiagnostic({
      transport: "sendMessage",
      phase: "sent",
      chatId,
      message: diagnosticMessage,
      resultKey: sent?.key ?? null,
      options,
    });
    return sent;
  } catch (error) {
    appendWhatsAppOutboundDiagnostic({
      transport: "sendMessage",
      phase: "failed",
      chatId,
      message: diagnosticMessage,
      options,
      error: formatErrorMessage(error),
    });
    throw error;
  }
}

/**
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} chatId
 * @param {any} msg
 * @param {Record<string, unknown>} options
 * @returns {Promise<void>}
 */
async function relayObservedWhatsAppMessage(sock, chatId, msg, options) {
  const diagnosticMessage = /** @type {Record<string, unknown>} */ (msg);
  appendWhatsAppOutboundDiagnostic({ transport: "relayMessage", phase: "attempt", chatId, message: diagnosticMessage, options });
  try {
    await sock.relayMessage(chatId, msg, options);
    appendWhatsAppOutboundDiagnostic({ transport: "relayMessage", phase: "sent", chatId, message: diagnosticMessage, options });
  } catch (error) {
    appendWhatsAppOutboundDiagnostic({
      transport: "relayMessage",
      phase: "failed",
      chatId,
      message: diagnosticMessage,
      options,
      error: formatErrorMessage(error),
    });
    throw error;
  }
}

/**
 * @param {RuntimeEventOutboundEvent} event
 * @returns {Record<string, unknown> | null}
 */
function getRawAcpSessionUpdate(event) {
  const raw = event.event.raw;
  if (!isRecord(raw) || raw.source !== "acp.jsonrpc" || raw.method !== "session/update") {
    return null;
  }
  const payload = isRecord(raw.payload) ? raw.payload : null;
  const update = isRecord(payload?.update) ? payload.update : null;
  if (update?.sessionUpdate !== "tool_call" && update?.sessionUpdate !== "tool_call_update") {
    return null;
  }
  return update;
}

/**
 * @param {Record<string, unknown>} update
 * @returns {Record<string, unknown> | null}
 */
function getRawAcpFirstLocation(update) {
  const locations = Array.isArray(update.locations) ? update.locations : [];
  for (const location of locations) {
    if (isRecord(location) && typeof location.path === "string" && location.path.length > 0) {
      return location;
    }
  }
  return null;
}

/**
 * @param {Record<string, unknown>} update
 * @returns {string | null}
 */
function getRawAcpFirstLocationPath(update) {
  const location = getRawAcpFirstLocation(update);
  return typeof location?.path === "string" ? location.path : null;
}

/**
 * @param {Record<string, unknown>} update
 * @returns {number | undefined}
 */
function getRawAcpFirstLocationLine(update) {
  const location = getRawAcpFirstLocation(update);
  return typeof location?.line === "number" ? location.line : undefined;
}

/**
 * @param {Record<string, unknown>} update
 * @returns {Record<string, unknown> | null}
 */
function getRawAcpInput(update) {
  return isRecord(update.rawInput) ? update.rawInput : null;
}

/**
 * @param {Record<string, unknown>} update
 * @returns {string | null}
 */
function getRawAcpReadPath(update) {
  const locationPath = getRawAcpFirstLocationPath(update);
  if (locationPath) {
    return locationPath;
  }
  const rawInput = getRawAcpInput(update);
  return typeof rawInput?.path === "string" && rawInput.path.length > 0 ? rawInput.path : null;
}

/**
 * @param {unknown} value
 * @returns {{ start: number, end: number } | null}
 */
function normalizeLineRange(value) {
  if (!isRecord(value)) {
    return null;
  }
  const { start, end } = value;
  if (typeof start !== "number"
    || typeof end !== "number"
    || !Number.isInteger(start)
    || !Number.isInteger(end)
    || start <= 0
    || end < start) {
    return null;
  }
  return { start, end };
}

/**
 * @param {Record<string, unknown>} update
 * @returns {{ start: number, end: number } | null}
 */
function getRawAcpCodexLineRange(update) {
  const meta = isRecord(update._meta) ? update._meta : null;
  const codex = isRecord(meta?.codex) ? meta.codex : null;
  return normalizeLineRange(codex?.lineRange);
}

/**
 * @param {Record<string, unknown>} update
 * @returns {string | null}
 */
function getRawAcpTitle(update) {
  return typeof update.title === "string" && update.title.trim().length > 0
    ? update.title.trim()
    : null;
}

/**
 * @param {string | null} title
 * @returns {boolean}
 */
function isRawAcpListFilesTitle(title) {
  return title === "List files" || !!title?.startsWith("List files in ");
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function joinedStringList(value) {
  if (!Array.isArray(value)) {
    return null;
  }
  const entries = value.map(nonEmptyString).filter((entry) => entry !== null);
  return entries.length > 0 ? entries.join(", ") : null;
}

/**
 * @param {Extract<RuntimeEventOutboundEvent["event"], { tool: unknown }>["tool"]} tool
 * @param {Record<string, unknown>} update
 * @returns {Extract<RuntimeEventOutboundEvent["event"], { tool: unknown }>["tool"] | null}
 */
function buildWhatsAppWebRuntimeToolFromRawAcp(tool, update) {
  const rawInput = getRawAcpInput(update);
  const action = isRecord(rawInput?.action) ? rawInput.action : null;
  const actionType = nonEmptyString(action?.type);
  if (!rawInput || !action || !actionType) {
    return null;
  }
  switch (actionType) {
    case "other":
      return {
        ...tool,
        name: "web_action_pending",
        arguments: { ...tool.arguments },
      };
    case "search": {
      const query = nonEmptyString(action.query)
        ?? joinedStringList(action.queries)
        ?? nonEmptyString(rawInput.query);
      return query
        ? {
          ...tool,
          name: "web_search_action",
          arguments: { ...tool.arguments, query },
        }
        : null;
    }
    case "openPage":
    case "open_page": {
      const refId = nonEmptyString(action.url);
      return refId
        ? {
          ...tool,
          name: "open",
          arguments: { ...tool.arguments, ref_id: refId },
        }
        : null;
    }
    case "findInPage":
    case "find_in_page": {
      const pattern = nonEmptyString(action.pattern);
      const refId = nonEmptyString(action.url);
      return pattern && refId
        ? {
          ...tool,
          name: "find",
          arguments: { ...tool.arguments, pattern, ref_id: refId },
        }
        : null;
    }
    default:
      return null;
  }
}

/**
 * @param {Record<string, unknown>} update
 * @returns {boolean}
 */
function hasRawAcpWebAction(update) {
  return buildWhatsAppWebRuntimeToolFromRawAcp({
    id: "",
    name: "",
    arguments: {},
  }, update) !== null;
}

/**
 * @param {Record<string, unknown>} update
 * @returns {string | null}
 */
function getRawAcpCommand(update) {
  const rawInput = isRecord(update.rawInput) ? update.rawInput : null;
  if (rawInput && typeof rawInput.command === "string" && rawInput.command.trim().length > 0) {
    return rawInput.command.trim();
  }
  const title = getRawAcpTitle(update);
  return title && title !== "Editing files" ? title : null;
}

/**
 * @param {Record<string, unknown>} update
 * @returns {string | null}
 */
function getRawAcpFormattedOutput(update) {
  const rawOutput = isRecord(update.rawOutput) ? update.rawOutput : null;
  return typeof rawOutput?.formatted_output === "string" ? rawOutput.formatted_output : null;
}

/**
 * @param {string} output
 * @returns {{ start: number, end: number } | null}
 */
function parseNumberedLineRange(output) {
  /** @type {number | null} */
  let start = null;
  /** @type {number | null} */
  let end = null;
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)(?:\t|→)/u);
    if (!match) {
      continue;
    }
    const lineNumber = Number(match[1]);
    if (!Number.isInteger(lineNumber) || lineNumber <= 0) {
      continue;
    }
    start ??= lineNumber;
    end = lineNumber;
  }
  return start !== null && end !== null ? { start, end } : null;
}

/**
 * @param {RuntimeEventOutboundEvent} event
 * @returns {{ start: number, end: number } | null}
 */
function getRawAcpReadOutputLineRange(event) {
  const update = getRawAcpSessionUpdate(event);
  if (!update || update.status !== "completed") {
    return null;
  }
  const output = getRawAcpFormattedOutput(update);
  return output ? parseNumberedLineRange(output) : null;
}

/**
 * @param {{ start: number, end: number }} range
 * @returns {string}
 */
function formatLineRange(range) {
  return range.start === range.end ? String(range.start) : `${range.start}-${range.end}`;
}

/**
 * @param {string} summary
 * @param {{ start: number, end: number } | null} range
 * @returns {string}
 */
function appendReadLineRange(summary, range) {
  if (!range || !summary.startsWith("*Read*") || /(?:_L\d+(?:-L\d+)?_|\*\d+(?:-\d+)?\*|`[^`]+:\d+(?:-\d+)?`)/.test(summary)) {
    return summary;
  }
  const rangeText = formatLineRange(range);
  return `${summary}  *${rangeText}*`;
}

/**
 * @param {number | undefined} line
 * @param {number | undefined} limit
 * @returns {{ start: number, end: number } | null}
 */
function lineLimitToRange(line, limit) {
  if (!Number.isInteger(line) || !Number.isInteger(limit) || line === undefined || limit === undefined || line <= 0 || limit <= 0) {
    return null;
  }
  return { start: line, end: line + limit - 1 };
}

/**
 * WhatsApp owns raw ACP presentation. Use the protocol payload when it carries
 * richer display facts than the canonical runtime event.
 * @param {Extract<RuntimeEventOutboundEvent["event"], { tool: unknown }>["tool"]} tool
 * @param {RuntimeEventOutboundEvent} event
 * @returns {Extract<RuntimeEventOutboundEvent["event"], { tool: unknown }>["tool"]}
 */
function buildWhatsAppRuntimeToolFromRawAcp(tool, event) {
  const update = getRawAcpSessionUpdate(event);
  if (!update) {
    return tool;
  }
  if (update.kind === "read") {
    const title = getRawAcpTitle(update);
    if (isRawAcpListFilesTitle(title)) {
      const listPath = getRawAcpFirstLocationPath(update);
      if (listPath) {
        return {
          ...tool,
          name: "List",
          arguments: {
            ...tool.arguments,
            path: listPath,
          },
        };
      }
    }
    const readPath = getRawAcpReadPath(update);
    if (readPath) {
      const rawInput = getRawAcpInput(update);
      const codexLineRange = getRawAcpCodexLineRange(update);
      const rawLine = typeof rawInput?.line === "number"
        ? rawInput.line
        : typeof rawInput?.offset === "number"
          ? rawInput.offset
          : undefined;
      const line = codexLineRange?.start ?? getRawAcpFirstLocationLine(update) ?? rawLine;
      const limit = codexLineRange
        ? codexLineRange.end - codexLineRange.start + 1
        : typeof rawInput?.limit === "number"
          ? rawInput.limit
          : undefined;
      return {
        ...tool,
        name: "Read",
        arguments: {
          ...tool.arguments,
          ...(typeof line === "number" ? { line } : {}),
          ...(typeof limit === "number" ? { limit } : {}),
          file_path: readPath,
        },
      };
    }
  }
  if (update.kind === "search" || hasRawAcpWebAction(update)) {
    const webTool = buildWhatsAppWebRuntimeToolFromRawAcp(tool, update);
    if (webTool) {
      return webTool;
    }
  }
  if (update.kind === "execute") {
    const command = getRawAcpCommand(update);
    if (command) {
      return {
        ...tool,
        name: "Shell",
        arguments: {
          ...tool.arguments,
          command,
        },
      };
    }
  }
  return tool;
}

/**
 * @param {Extract<RuntimeEventOutboundEvent["event"], { tool: unknown }>["tool"]} tool
 * @returns {boolean}
 */
function isLowSignalPinnedRuntimeTool(tool) {
  const name = typeof tool.name === "string" ? tool.name.trim() : "";
  return name === "Read"
    || name === "List"
    || /^Read\b/i.test(name)
    || /^List files\b/i.test(name);
}

/**
 * @typedef {{
 *   id: string,
 *   chatId: string,
 *   messageKey: import('@whiskeysockets/baileys').WAMessageKey,
 *   messageKind: "text" | "image",
 *   createdAt: string,
 *   expiresAt: string,
 * }} WhatsAppEditHandleRecord
 */

/**
 * @param {import('@whiskeysockets/baileys').WAMessageKey} key
 * @returns {import('@whiskeysockets/baileys').WAMessageKey}
 */
function serializeWhatsAppMessageKey(key) {
  return {
    ...(typeof key.remoteJid === "string" ? { remoteJid: key.remoteJid } : {}),
    ...(typeof key.id === "string" ? { id: key.id } : {}),
    ...(typeof key.fromMe === "boolean" ? { fromMe: key.fromMe } : {}),
  };
}

/**
 * @param {unknown} value
 * @returns {import('@whiskeysockets/baileys').WAMessageKey | null}
 */
function parseWhatsAppMessageKey(value) {
  if (typeof value === "string") {
    try {
      return parseWhatsAppMessageKey(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (!isRecord(value) || typeof value.id !== "string") {
    return null;
  }
  return {
    ...(typeof value.remoteJid === "string" ? { remoteJid: value.remoteJid } : {}),
    ...(typeof value.fromMe === "boolean" ? { fromMe: value.fromMe } : {}),
    id: value.id,
  };
}

/**
 * @param {import("../../store.js").WhatsAppEditHandleRow} row
 * @returns {WhatsAppEditHandleRecord | null}
 */
function editHandleRecordFromRow(row) {
  const messageKey = parseWhatsAppMessageKey(row.message_key_json);
  if (!messageKey) {
    return null;
  }
  return {
    id: row.id,
    chatId: row.chat_id,
    messageKey,
    messageKind: row.message_kind,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

/**
 * @param {string} chatId
 * @param {import('@whiskeysockets/baileys').WAMessageKey} key
 * @param {"text" | "image"} messageKind
 * @param {Date} [now]
 * @returns {WhatsAppEditHandleRecord}
 */
function createWhatsAppEditHandleRecord(chatId, key, messageKind, now = new Date()) {
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + WHATSAPP_EDIT_HANDLE_TTL_MS).toISOString();
  return {
    id: `wa-edit-${randomBytes(16).toString("hex")}`,
    chatId,
    messageKey: serializeWhatsAppMessageKey(key),
    messageKind,
    createdAt,
    expiresAt,
  };
}

/**
 * @param {WhatsAppEditHandleRecord} record
 * @param {import("../../store.js").Store | undefined} store
 * @returns {Promise<void>}
 */
async function rememberWhatsAppEditHandle(record, store) {
  inMemoryEditHandles.set(record.id, record);
  if (!store) {
    return;
  }
  await store.saveWhatsAppEditHandle({
    id: record.id,
    chatId: record.chatId,
    messageKeyJson: record.messageKey,
    messageKind: record.messageKind,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  });
  await store.deleteExpiredWhatsAppEditHandles(new Date().toISOString());
}

/**
 * @param {string} transportHandleId
 * @param {import("../../store.js").Store | undefined} store
 * @returns {Promise<WhatsAppEditHandleRecord | null>}
 */
async function resolveWhatsAppEditHandle(transportHandleId, store) {
  const row = store ? await store.getWhatsAppEditHandle(transportHandleId) : null;
  const record = row ? editHandleRecordFromRow(row) : null;
  if (record) {
    inMemoryEditHandles.set(record.id, record);
    return record;
  }
  return inMemoryEditHandles.get(transportHandleId) ?? null;
}

/**
 * @param {WhatsAppEditHandleRecord} record
 * @param {Date} [now]
 * @returns {boolean}
 */
function isExpiredWhatsAppEditHandle(record, now = new Date()) {
  return Date.parse(record.expiresAt) <= now.getTime();
}

/**
 * @param {{ messageKey?: import('@whiskeysockets/baileys').WAMessageKey, messageKind?: "text" | "image", fallbackKeyId?: string }} target
 * @param {{ chatId: string }} fallback
 * @returns {{ key: import('@whiskeysockets/baileys').WAMessageKey, messageKind: "text" | "image" } | null}
 */
function resolveWhatsAppEditTarget(target, fallback) {
  if (target.messageKey?.id) {
    return {
      key: {
        remoteJid: typeof target.messageKey.remoteJid === "string" ? target.messageKey.remoteJid : fallback.chatId,
        fromMe: true,
        id: target.messageKey.id,
      },
      messageKind: target.messageKind ?? "text",
    };
  }
  if (!target.fallbackKeyId) {
    return null;
  }
  return {
    key: { remoteJid: fallback.chatId, fromMe: true, id: target.fallbackKeyId },
    messageKind: "text",
  };
}

/**
 * @param {import('@whiskeysockets/baileys').WAMessageKey | undefined} key
 * @param {string} chatId
 * @returns {import('@whiskeysockets/baileys').WAMessageKey | null}
 */
function resolveOutgoingMessageKey(key, chatId) {
  if (!key?.id) {
    return null;
  }
  return {
    remoteJid: typeof key.remoteJid === "string" ? key.remoteJid : chatId,
    fromMe: true,
    id: key.id,
  };
}

/**
 * @param {string} text
 * @returns {string}
 */
function getFirstLine(text) {
  return text.split(/\r?\n/, 1)[0] ?? "";
}

/**
 * @param {import('@whiskeysockets/baileys').WAMessageKey | undefined} key
 * @returns {string | undefined}
 */
function getMessageKeyId(key) {
  return typeof key?.id === "string" ? key.id : undefined;
}

/**
 * @param {PinnedStatusDeliveryObserver | undefined} observer
 * @param {PinnedStatusDeliveryEvent} event
 * @returns {void}
 */
function observePinnedStatusDelivery(observer, event) {
  if (!observer) {
    return;
  }
  try {
    observer(event);
  } catch (error) {
    log.warn("Pinned status delivery observer failed", {
      chatId: event.chatId,
      type: event.type,
      error: formatErrorMessage(error),
    });
  }
}

/**
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} chatId
 * @param {import('@whiskeysockets/baileys').WAMessageKey | undefined} key
 * @param {PinnedStatusDeliveryObserver | undefined} [observer]
 * @returns {Promise<void>}
 */
async function pinWhatsAppMessage(sock, chatId, key, observer) {
  const pinKey = resolveOutgoingMessageKey(key, chatId);
  if (!pinKey) {
    observePinnedStatusDelivery(observer, { type: "pin.skipped", chatId });
    return;
  }
  const messageId = getMessageKeyId(pinKey);
  try {
    await sendObservedWhatsAppMessage(sock, chatId, {
      pin: pinKey,
      type: proto.PinInChat.Type.PIN_FOR_ALL,
      time: TURN_STATUS_PIN_SECONDS,
    }, undefined);
    observePinnedStatusDelivery(observer, { type: "pin.succeeded", chatId, messageId });
  } catch (error) {
    observePinnedStatusDelivery(observer, {
      type: "pin.failed",
      chatId,
      messageId,
      error: formatErrorMessage(error),
    });
    log.warn("Failed to pin WhatsApp status message", {
      chatId,
      messageId: pinKey.id,
      error: formatErrorMessage(error),
    });
  }
}

/**
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} chatId
 * @param {import('@whiskeysockets/baileys').WAMessageKey | undefined} key
 * @param {PinnedStatusDeliveryObserver | undefined} [observer]
 * @returns {Promise<void>}
 */
async function unpinWhatsAppMessage(sock, chatId, key, observer) {
  const pinKey = resolveOutgoingMessageKey(key, chatId);
  if (!pinKey) {
    observePinnedStatusDelivery(observer, { type: "unpin.skipped", chatId });
    return;
  }
  const messageId = getMessageKeyId(pinKey);
  try {
    await sendObservedWhatsAppMessage(sock, chatId, {
      pin: pinKey,
      type: proto.PinInChat.Type.UNPIN_FOR_ALL,
    }, undefined);
    observePinnedStatusDelivery(observer, { type: "unpin.succeeded", chatId, messageId });
  } catch (error) {
    observePinnedStatusDelivery(observer, {
      type: "unpin.failed",
      chatId,
      messageId,
      error: formatErrorMessage(error),
    });
    log.warn("Failed to unpin WhatsApp status message", {
      chatId,
      messageId: pinKey.id,
      error: formatErrorMessage(error),
    });
  }
}

/**
 * @param {SubagentMessageEvent} event
 * @returns {SendContent}
 */
function renderSubagentMessageContent(event) {
  const title = event.agentNickname
    ? `**Sub-agent ${event.agentNickname}**`
    : "**Sub-agent**";
  const detail = event.agentRole ? `_${event.agentRole}_` : "";
  return [{ type: "markdown", text: [`🧩 ${title}`, detail, event.text].filter(Boolean).join("\n") }];
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function formatRuntimePayload(value) {
  if (value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * @param {string | undefined} provider
 * @returns {string}
 */
function formatRuntimeProvider(provider) {
  const normalized = provider?.trim();
  return normalized ? normalized.toUpperCase() : "Provider";
}

/**
 * @param {SendContent} content
 * @returns {string}
 */
function extractOutboundContentText(content) {
  if (typeof content === "string") {
    return content;
  }
  const blocks = Array.isArray(content) ? content : [content];
  return blocks
    .map((block) => {
      if (!isRecord(block)) {
        return "";
      }
      if ("text" in block && typeof block.text === "string") {
        return block.text;
      }
      if ("code" in block && typeof block.code === "string") {
        return block.code;
      }
      return "";
    })
    .join("");
}

/**
 * @param {OutboundEvent} event
 * @returns {"👍" | "👎" | null}
 */
function getGuardianReviewPrefixEmoji(event) {
  if (event.kind !== "content" || event.source !== "llm") {
    return null;
  }
  const text = extractOutboundContentText(event.content).trim();
  if (/^Guardian warning: Automatic approval review approved\b/.test(text)) {
    return "👍";
  }
  if (/^Guardian warning: Automatic approval review denied\b/.test(text)) {
    return "👎";
  }
  return null;
}

/**
 * @template {{ handle?: MessageHandle }} T
 * @param {Map<string, T>} stateById
 * @returns {T | undefined}
 */
function getLastRuntimeState(stateById) {
  /** @type {T | undefined} */
  let lastState;
  for (const state of stateById.values()) {
    if (state.handle) {
      lastState = state;
    }
  }
  return lastState;
}

/**
 * @param {"started" | "completed" | "failed"} status
 * @param {string} summary
 * @param {"👍" | "👎" | undefined} [reviewPrefix]
 * @returns {string}
 */
function formatRuntimeCommandText(status, summary, reviewPrefix) {
  const prefix = reviewPrefix ? `${reviewPrefix} ` : "";
  return `${prefix}${getRuntimeCommandIcon(status)} ${summary}`;
}

/**
 * @param {"started" | "updated" | "completed" | "failed"} status
 * @param {string} summary
 * @param {"👍" | "👎" | undefined} [reviewPrefix]
 * @returns {string}
 */
function formatRuntimeToolText(status, summary, reviewPrefix) {
  const prefix = reviewPrefix ? `${reviewPrefix} ` : "";
  return `${prefix}${getRuntimeToolIcon(status)} ${summary}`;
}

/**
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} chatId
 * @param {MessageHandle} handle
 * @param {string} text
 * @param {MessageSource} source
 * @param {{ quoted?: BaileysMessage } | undefined} options
 * @param {import("../runtime/reaction-runtime.js").ReactionRuntime | undefined} reactionRuntime
 * @param {OutboundEvent} event
 * @param {{ editHandleStore?: import("../../store.js").Store }} sendOptions
 * @returns {Promise<MessageHandle | undefined>}
 */
async function updateRuntimeHandleOrSendReplacement(sock, chatId, handle, text, source, options, reactionRuntime, event, sendOptions) {
  try {
    await handle.update({ kind: "text", text });
    return handle;
  } catch (error) {
    if (!isStaleWhatsAppEditHandleError(error)) {
      throw error;
    }
    return sendBlocks(sock, chatId, source, text, options, reactionRuntime, event, {
      editHandleStore: sendOptions.editHandleStore,
    });
  }
}

/**
 * @param {string} summary
 * @returns {boolean}
 */
function hasRuntimeSummaryDetail(summary) {
  return summary.includes("  ") || summary.includes("\n");
}

/**
 * @param {string} summary
 * @returns {{ path: string, hasRange: boolean } | null}
 */
function parseReadRuntimeSummary(summary) {
  if (!summary.startsWith("*Read*")) {
    return null;
  }
  const pathMatch = summary.match(/`([^`]+)`/);
  if (!pathMatch?.[1]) {
    return null;
  }
  return {
    path: pathMatch[1],
    hasRange: /(?:_L\d+(?:-L\d+)?_|\*\d+(?:-\d+)?\*|`[^`]+:\d+(?:-\d+)?`)/.test(summary),
  };
}

/**
 * @param {string} p
 * @returns {string}
 */
function basenameForDisplayPath(p) {
  const normalized = p.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.at(-1) ?? normalized;
}

/**
 * @param {string} summary
 * @returns {{ prefix: string, path: string } | null}
 */
function parseRuntimePathSummary(summary) {
  const pathMatch = summary.match(/`([^`]+)`/);
  if (!pathMatch?.[1] || pathMatch.index == null) {
    return null;
  }
  return {
    prefix: summary.slice(0, pathMatch.index),
    path: pathMatch[1],
  };
}

/**
 * @param {string | undefined} previousSummary
 * @param {string} nextSummary
 * @returns {boolean}
 */
function shouldPreserveRuntimeSummary(previousSummary, nextSummary) {
  if (!previousSummary) {
    return false;
  }
  const previousRead = parseReadRuntimeSummary(previousSummary);
  const nextRead = parseReadRuntimeSummary(nextSummary);
  if (previousRead && nextRead && basenameForDisplayPath(previousRead.path) === basenameForDisplayPath(nextRead.path)) {
    if (previousRead.hasRange && !nextRead.hasRange) {
      return true;
    }
    if (previousRead.path.length > nextRead.path.length) {
      return true;
    }
  }
  const previousPath = parseRuntimePathSummary(previousSummary);
  const nextPath = parseRuntimePathSummary(nextSummary);
  if (
    previousPath
    && nextPath
    && previousPath.prefix === nextPath.prefix
    && basenameForDisplayPath(previousPath.path) === basenameForDisplayPath(nextPath.path)
    && previousPath.path.length > nextPath.path.length
  ) {
    return true;
  }
  return Boolean(previousSummary)
    && hasRuntimeSummaryDetail(/** @type {string} */ (previousSummary))
    && !hasRuntimeSummaryDetail(nextSummary);
}

/**
 * @param {ReturnType<typeof createCompactToolActivityState> & { handle?: MessageHandle }} state
 * @returns {{ id: string, summary: string, completed: boolean, failed: boolean, reviewPrefix?: "👍" | "👎" } | undefined}
 */
function getLatestActiveCompactEntry(state) {
  for (let index = state.entries.length - 1; index >= 0; index -= 1) {
    const entry = state.entries[index];
    if (!entry.completed && !entry.failed) {
      return entry;
    }
  }
  return undefined;
}

/**
 * @param {string} chatId
 * @param {"👍" | "👎"} emoji
 * @returns {Promise<boolean>}
 */
async function prefixLatestToolMessage(chatId, emoji) {
  const compactState = compactToolActivityByChat.get(chatId);
  if (compactState) {
    const compactEntry = getLatestActiveCompactEntry(compactState);
    if (compactEntry) {
      compactEntry.reviewPrefix = emoji;
      await flushCompactToolActivity(compactState);
      return true;
    }
  }
  const toolStateById = runtimeToolsByChat.get(chatId);
  if (toolStateById) {
    const toolState = getLastRuntimeState(toolStateById);
    if (toolState?.handle) {
      toolState.reviewPrefix = emoji;
      await toolState.handle.update({ kind: "text", text: formatRuntimeToolText("started", toolState.summary, emoji) });
      return true;
    }
  }
  const commandStateById = runtimeCommandsByChat.get(chatId);
  if (commandStateById) {
    const commandState = getLastRuntimeState(commandStateById);
    if (commandState?.handle) {
      commandState.reviewPrefix = emoji;
      await commandState.handle.update({
        kind: "text",
        text: formatRuntimeCommandText("started", formatRuntimeCommandSummary(commandState.command), emoji),
      });
      return true;
    }
  }
  return false;
}

/**
 * @param {string} tool
 * @param {string} [detail]
 * @returns {string}
 */
function formatRuntimeProgressEntry(tool, detail) {
  if (!detail) {
    return `*${tool}*`;
  }
  return detail.startsWith("\n") ? `*${tool}*${detail}` : `*${tool}*  ${detail}`;
}

/**
 * @param {string} command
 * @returns {string}
 */
function formatRuntimeCommandSummary(command) {
  const trimmedCommand = command.trim();
  if (!trimmedCommand) {
    return formatRuntimeProgressEntry("Shell");
  }
  if (trimmedCommand.includes("\n")) {
    return formatRuntimeProgressEntry("Shell", `\n\`\`\`\n${trimmedCommand}\n\`\`\``);
  }
  return formatRuntimeProgressEntry("Shell", `\`${trimmedCommand}\``);
}

/**
 * @param {string} value
 * @returns {string}
 */
function stripShellArgumentQuotes(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/'\\''/g, "'");
  }
  if (trimmed.length >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    return trimmed.slice(1, -1).replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  }
  return trimmed;
}

/**
 * @param {string} command
 * @returns {string}
 */
function normalizePinnedShellCommand(command) {
  const trimmed = command.trim();
  const shellMatch = /^(?:\/[\w./-]+\/)?(?:zsh|bash|sh)\s+-lc\s+([\s\S]+)$/.exec(trimmed);
  if (!shellMatch?.[1]) {
    return trimmed;
  }
  return stripShellArgumentQuotes(shellMatch[1]);
}

/**
 * @param {Extract<RuntimeEventOutboundEvent["event"], { tool: unknown }>["tool"]} tool
 * @returns {string}
 */
function getPinnedRuntimeToolKey(tool) {
  if (tool.name.trim() === "Shell") {
    const command = getStringArg(tool.arguments, ["command"]);
    if (command) {
      return `tool:shell:${normalizePinnedShellCommand(command)}`;
    }
  }
  return `tool:${tool.id}`;
}

/**
 * @param {Extract<RuntimeEventOutboundEvent["event"], { tool: unknown }>["tool"]} tool
 * @param {string | null | undefined} cwd
 * @returns {string | null}
 */
function formatPinnedRuntimeToolSummary(tool, cwd) {
  if (tool.name.trim() === "Shell") {
    const command = getStringArg(tool.arguments, ["command"]);
    if (command) {
      return formatRuntimeCommandSummary(normalizePinnedShellCommand(command));
    }
  }
  return formatRuntimeToolSummary(tool, cwd);
}

/**
 * @param {"started" | "completed" | "failed"} status
 * @returns {string}
 */
function getRuntimeCommandIcon(status) {
  if (status === "failed") {
    return "❌";
  }
  if (status === "completed") {
    return "✅";
  }
  return "🔧";
}

/**
 * @param {Record<string, unknown>} args
 * @param {string[]} names
 * @returns {string | undefined}
 */
function getStringArg(args, names) {
  for (const name of names) {
    const value = args[name];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

/**
 * @param {Extract<RuntimeEventOutboundEvent["event"], { tool: unknown }>["tool"]} tool
 * @returns {boolean}
 */
function isNoopRuntimeTool(tool) {
  return tool.name === "Editing files" && Object.keys(tool.arguments).length === 0;
}

/**
 * @param {string} name
 * @returns {{ kind: "read" | "list", path?: string } | null}
 */
function parseRawFileToolTitle(name) {
  const trimmed = name.trim();
  const readMatch = /^Read\s+(.+)$/i.exec(trimmed);
  if (readMatch?.[1]) {
    const readPath = readMatch[1].trim().replace(/^["'`]|["'`]$/g, "");
    if (readPath === "file") {
      return null;
    }
    return { kind: "read", path: readPath };
  }
  const listMatch = /^List files(?:\s+in\s+(.+))?$/i.exec(trimmed);
  if (listMatch) {
    return {
      kind: "list",
      ...(listMatch[1] ? { path: listMatch[1].trim().replace(/^["'`]|["'`]$/g, "") } : {}),
    };
  }
  return null;
}

/**
 * @param {Extract<RuntimeEventOutboundEvent["event"], { tool: unknown }>["tool"]} tool
 * @param {string | null | undefined} cwd
 * @returns {string | null}
 */
function formatRuntimeToolSummary(tool, cwd) {
  if (tool.name === "Read" || tool.name === "Read file") {
    const readPath = getStringArg(tool.arguments, ["file_path", "path", "filePath"]);
    if (readPath) {
      const line = typeof tool.arguments.line === "number"
        ? tool.arguments.line
        : typeof tool.arguments.offset === "number" ? tool.arguments.offset : undefined;
      const limit = typeof tool.arguments.limit === "number" ? tool.arguments.limit : undefined;
      return appendReadLineRange(
        formatRuntimeProgressEntry("Read", `\`${shortenPath(readPath, cwd ?? null)}\``),
        lineLimitToRange(line, limit),
      );
    }
  }
  const rawFileTool = parseRawFileToolTitle(tool.name);
  if (rawFileTool?.kind === "read" && rawFileTool.path) {
    return formatRuntimeProgressEntry("Read", `\`${shortenPath(rawFileTool.path, cwd ?? null)}\``);
  }
  if (rawFileTool?.kind === "list") {
    return formatRuntimeProgressEntry(
      "List",
      rawFileTool.path ? `\`${shortenPath(rawFileTool.path, cwd ?? null)}\`` : undefined,
    );
  }
  const semanticSummary = formatSemanticToolSummary(tool.name, tool.arguments, cwd);
  if (semanticSummary) {
    return semanticSummary;
  }
  const displayName = tool.name.trim() || "Tool";
  if (displayName === "Shell") {
    const command = getStringArg(tool.arguments, ["command"]);
    if (command) {
      return formatRuntimeCommandSummary(command);
    }
  }
  if (displayName === "stdin" || displayName === "write_stdin") {
    return null;
  }
  const pathDetail = getStringArg(tool.arguments, ["path", "file_path", "filePath"]);
  if (pathDetail) {
    return formatRuntimeProgressEntry(displayName, `\`${shortenPath(pathDetail, cwd ?? null)}\``);
  }
  const textDetail = getStringArg(tool.arguments, ["title", "message", "prompt", "query", "q"]);
  return formatRuntimeProgressEntry(displayName, textDetail);
}

/**
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {string | null | undefined} cwd
 * @returns {string | null}
 */
function formatSemanticToolSummary(name, args, cwd) {
  const presentation = buildToolPresentation(name, args, undefined, cwd ?? null, undefined);
  if (!presentation) {
    return null;
  }
  if (presentation.kind === "generic") {
    return null;
  }
  return formatToolPresentationSummary(presentation);
}

/**
 * @param {"started" | "updated" | "completed" | "failed"} status
 * @returns {string}
 */
function getRuntimeToolIcon(status) {
  if (status === "failed") {
    return "❌";
  }
  if (status === "completed") {
    return "✅";
  }
  return "🔧";
}

/**
 * @param {string} value
 * @returns {string}
 */
function stripSimpleMarkdown(value) {
  return value.trim().replace(/^[*_`]+|[*_`]+$/g, "");
}

/**
 * @param {string} tool
 * @param {string} [detail]
 * @returns {string}
 */
function formatCompactEntry(tool, detail) {
  if (!detail) {
    return `*${tool}*`;
  }
  return detail.startsWith("\n") ? `*${tool}*${detail}` : `*${tool}*  ${detail}`;
}

/**
 * @param {string} command
 * @returns {string}
 */
function formatCompactCommand(command) {
  const trimmedCommand = command.trim();
  if (!trimmedCommand) {
    return formatCompactEntry("Shell");
  }
  if (trimmedCommand.includes("\n")) {
    return formatCompactEntry("Shell", `\n\`\`\`\n${trimmedCommand}\n\`\`\``);
  }
  return formatCompactEntry("Shell", `\`${trimmedCommand}\``);
}

/**
 * @param {string[]} paths
 * @param {number | undefined} line
 * @param {number | undefined} limit
 * @returns {string}
 */
function formatCompactRead(paths, line, limit) {
  const displayPaths = paths
    .filter((filePath) => typeof filePath === "string" && filePath.length > 0)
    .map((filePath) => `\`${filePath}\``);
  const summary = formatCompactEntry("Read", displayPaths.length > 0 ? displayPaths.join(", ") : undefined);
  return appendReadLineRange(summary, lineLimitToRange(line, limit));
}

/**
 * @param {string | undefined} value
 * @returns {Record<string, unknown>}
 */
function parseCompactToolArguments(value) {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return /** @type {Record<string, unknown>} */ (parsed);
    }
  } catch {
    return {};
  }
  return {};
}

/**
 * @param {Record<string, unknown>} args
 * @param {string | null | undefined} cwd
 * @returns {string | undefined}
 */
function formatGenericPathDetail(args, cwd) {
  const filePath = typeof args.path === "string"
    ? args.path
    : typeof args.file_path === "string"
      ? args.file_path
      : typeof args.filePath === "string"
        ? args.filePath
        : undefined;
  return filePath ? `\`${shortenPath(filePath, cwd ?? null)}\`` : undefined;
}

/**
 * @param {Record<string, unknown>} args
 * @returns {string | undefined}
 */
function formatGenericTextDetail(args) {
  const text = getStringArg(args, ["title", "message", "prompt", "query", "q"]);
  return text;
}

/**
 * @param {string} toolName
 * @param {Record<string, unknown>} args
 * @param {string | null | undefined} cwd
 * @returns {string}
 */
function formatGenericCompactToolName(toolName, args, cwd) {
  const detail = formatGenericPathDetail(args, cwd) ?? formatGenericTextDetail(args);
  return formatCompactEntry(toolName, detail);
}

/**
 * @param {CompactToolActivityEvent["activity"]} activity
 * @param {string | null | undefined} cwd
 * @returns {string | null}
 */
function formatCompactToolActivitySummary(activity, cwd) {
  if (activity.type === "command") {
    return formatCompactCommand(activity.command);
  }
  if (activity.type === "file_read") {
    return formatCompactRead(activity.paths, activity.line, activity.limit);
  }
  if (activity.type !== "tool" || !activity.toolCall) {
    return null;
  }
  const args = parseCompactToolArguments(activity.toolCall.arguments);
  if (activity.toolCall.name === "Shell") {
    const command = getStringArg(args, ["command"]);
    if (command) {
      return formatCompactCommand(command);
    }
  }
  const presentation = buildToolPresentation(activity.toolCall.name, args, undefined, cwd ?? null, undefined);
  if (!presentation) {
    return null;
  }
  switch (presentation.kind) {
    case "activity":
      return formatToolPresentationSummary(presentation);
    case "file":
      return formatCompactEntry(presentation.toolName, `\`${presentation.filePath}\``);
    case "plan":
      return formatCompactEntry("Plan");
    case "generic": {
      const summary = presentation.summary.trim();
      if (!summary || stripSimpleMarkdown(summary) === stripSimpleMarkdown(presentation.toolName)) {
        return formatGenericCompactToolName(presentation.toolName, args, cwd);
      }
      const detail = !summary.includes("\n")
        ? `\`${summary}\``
        : undefined;
      return detail ? formatCompactEntry(presentation.toolName, detail) : formatGenericCompactToolName(presentation.toolName, args, cwd);
    }
    default:
      return formatCompactEntry(activity.toolCall.name);
  }
}

/**
 * @param {ToolCallEvent} event
 * @returns {ToolPresentation | null}
 */
function buildToolPresentationFromToolCallEvent(event) {
  const args = parseToolArgs(event.toolCall.arguments);
  const formatToolCall = typeof event.displaySummary === "string"
    ? () => event.displaySummary ?? ""
    : undefined;
  return buildToolPresentation(
    event.toolCall.name,
    args,
    formatToolCall,
    event.cwd ?? null,
    event.context,
  );
}

/**
 * @param {import("../tool-presentation-model.js").ToolActivitySummary} activity
 * @returns {boolean}
 */
function shouldSuppressToolActivity(activity) {
  return activity.title === "stdin" && activity.lines.length === 0;
}

/**
 * @param {RuntimeEventOutboundEvent["event"]} event
 * @returns {FileChangeEvent}
 */
function fileChangeEventFromRuntimeEvent(event) {
  if (event.type !== "file-change.completed") {
    throw new Error(`Expected file-change runtime event, got ${event.type}.`);
  }
  const change = event.change;
  return {
    kind: "file_change",
    path: change.path,
    ...(change.summary !== undefined && { summary: change.summary }),
    ...(change.diff !== undefined && { diff: change.diff }),
    ...(change.kind !== undefined && { changeKind: change.kind }),
    ...(change.source !== undefined && { source: change.source }),
    ...(change.itemId !== undefined && { itemId: change.itemId }),
    ...(change.stage !== undefined && { stage: change.stage }),
    ...(change.oldText !== undefined && { oldText: change.oldText }),
    ...(change.newText !== undefined && { newText: change.newText }),
    ...("cwd" in change && change.cwd !== undefined && { cwd: change.cwd }),
  };
}

/**
 * @param {RuntimeEventOutboundEvent["event"]} event
 * @returns {{ kind: "compact" | "error", icon: string, provider: string, summary: string, detail?: string, closesStatus?: boolean }}
 */
function formatRuntimeEventPresentation(event) {
  const provider = formatRuntimeProvider(event.provider);
  switch (event.type) {
    case "session.started":
    case "session.updated":
    case "session.stopped":
      return {
        kind: "compact",
        icon: "🔄",
        provider,
        summary: `session ${event.session.status}`,
        closesStatus: event.type === "session.stopped",
      };
    case "turn.started":
    case "turn.completed":
      return {
        kind: "compact",
        icon: "🔄",
        provider,
        summary: `turn ${event.turn.status ?? event.type.split(".")[1]}`,
        closesStatus: event.type === "turn.completed",
      };
    case "request.opened":
    case "request.resolved":
      return {
        kind: "compact",
        icon: "🔄",
        provider,
        summary: `request ${event.type.split(".")[1]}: ${event.request.summary ?? event.request.kind}`,
        ...(event.request.detail ? { detail: event.request.detail } : {}),
      };
    case "user-input.requested":
    case "user-input.resolved": {
      const questions = event.request.questions.map((question) => question.question).filter(Boolean).join("; ");
      return {
        kind: "compact",
        icon: "🔄",
        provider,
        summary: `user input ${event.type.split(".")[1]}${questions ? `: ${questions}` : ""}`,
      };
    }
    case "item.started":
    case "item.updated":
    case "item.completed":
      return {
        kind: "compact",
        icon: "🔄",
        provider,
        summary: `${event.item.kind} item ${event.type.split(".")[1]}`,
        ...(event.item.text ? { detail: event.item.text } : {}),
      };
    case "extension.notification":
    case "extension.request": {
      const payload = formatRuntimePayload(event.payload);
      return {
        kind: "compact",
        icon: "🔄",
        provider,
        summary: `${event.type.replace(".", " ")}: ${event.method}`,
        ...(payload ? { detail: payload } : {}),
      };
    }
    case "model.rerouted":
      return {
        kind: "compact",
        icon: "🔄",
        provider,
        summary: `model rerouted: ${event.fromModel ?? "default"} -> ${event.toModel ?? "default"}`,
        ...(event.reason ? { detail: event.reason } : {}),
      };
    case "config.warning":
    case "runtime.warning":
      return {
        kind: "compact",
        icon: "⚠️",
        provider,
        summary: event.summary ?? event.message ?? `${provider} ${event.type}`,
        ...(event.details ? { detail: event.details } : {}),
      };
    case "runtime.error":
      return {
        kind: "error",
        icon: "❌",
        provider,
        summary: event.summary ?? event.message ?? event.details ?? `${provider} runtime error`,
      };
    default:
      return {
        kind: "compact",
        icon: "🔄",
        provider,
        summary: `${provider} ${event.type}`,
      };
  }
}

/**
 * @param {RuntimeEventOutboundEvent["event"]} event
 * @returns {boolean}
 */
function shouldSuppressRuntimeEvent(event) {
  if (event.provider === "codex") {
    return event.type === "session.started"
      || event.type === "session.updated"
      || event.type === "session.stopped"
      || event.type === "turn.completed";
  }

  if (event.provider === "acp" && event.type.startsWith("item.")) {
    return true;
  }

  return false;
}

/**
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} chatId
 * @param {RuntimeEventOutboundEvent} event
 * @param {{ quoted?: BaileysMessage } | undefined} options
 * @param {import("../runtime/reaction-runtime.js").ReactionRuntime | undefined} reactionRuntime
 * @param {{ editHandleStore?: import("../../store.js").Store, outputVisibility?: import("../../chat-output-visibility.js").OutputVisibility, pinnedStatusDeliveryObserver?: PinnedStatusDeliveryObserver }} sendOptions
 * @returns {Promise<MessageHandle | undefined>}
 */
async function sendRuntimeFileChangeEvent(sock, chatId, event, options, reactionRuntime, sendOptions) {
  const fileChange = fileChangeEventFromRuntimeEvent(event.event);
  if (fileChange.source === "snapshot") {
    return sendSnapshotRuntimeFileChangeEvent(sock, chatId, fileChange, options, reactionRuntime, event, sendOptions);
  }
  return sendBlocks(sock, chatId, "tool-call", renderFileChangeContent(fileChange), options, reactionRuntime, event, {
    workdir: fileChange.cwd ?? null,
    editHandleStore: sendOptions.editHandleStore,
  });
}

/**
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} chatId
 * @param {FileChangeEvent} fileChange
 * @param {{ quoted?: BaileysMessage } | undefined} options
 * @param {import("../runtime/reaction-runtime.js").ReactionRuntime | undefined} reactionRuntime
 * @param {RuntimeEventOutboundEvent} event
 * @param {{ editHandleStore?: import("../../store.js").Store, outputVisibility?: import("../../chat-output-visibility.js").OutputVisibility, pinnedStatusDeliveryObserver?: PinnedStatusDeliveryObserver }} sendOptions
 * @returns {Promise<MessageHandle | undefined>}
 */
async function sendSnapshotRuntimeFileChangeEvent(sock, chatId, fileChange, options, reactionRuntime, event, sendOptions) {
  const diffText = buildSnapshotFileChangeDiffText(fileChange);
  if (!diffText) {
    return sendBlocks(sock, chatId, "tool-call", renderFileChangeContent(fileChange), options, reactionRuntime, event, {
      workdir: fileChange.cwd ?? null,
      editHandleStore: sendOptions.editHandleStore,
    });
  }

  const diffBatches = splitSnapshotDiffText(diffText);
  /** @type {MessageHandle | undefined} */
  let handle;
  let deliveredLines = 0;
  const totalLines = countDiffLines(diffText);
  /** @param {string} diffBatch */
  const sendDiffBatch = async (diffBatch) => sendBlocks(
    sock,
    chatId,
    "tool-call",
    renderFileChangeContent({ ...fileChange, diff: diffBatch }),
    options,
    reactionRuntime,
    event,
    {
      workdir: fileChange.cwd ?? null,
      editHandleStore: sendOptions.editHandleStore,
    },
  );

  for (let index = 0; index < diffBatches.length; index += 1) {
    const diffBatch = diffBatches[index] ?? "";
    deliveredLines += countDiffLines(diffBatch);
    handle = await sendDiffBatch(diffBatch);

    if (index >= diffBatches.length - 1) {
      break;
    }

    await requestSnapshotDiffContinuation(
      sock,
      chatId,
      options,
      reactionRuntime,
      deliveredLines,
      totalLines,
      async () => {
        for (let nextIndex = index + 1; nextIndex < diffBatches.length; nextIndex += 1) {
          await sendDiffBatch(diffBatches[nextIndex] ?? "");
        }
      },
    );
    break;
  }

  return handle;
}

/**
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} chatId
 * @param {RuntimeEventOutboundEvent} event
 * @param {{ quoted?: BaileysMessage } | undefined} options
 * @param {import("../runtime/reaction-runtime.js").ReactionRuntime | undefined} reactionRuntime
 * @param {{ editHandleStore?: import("../../store.js").Store, outputVisibility?: import("../../chat-output-visibility.js").OutputVisibility, pinnedStatusDeliveryObserver?: PinnedStatusDeliveryObserver }} sendOptions
 * @returns {Promise<MessageHandle | undefined>}
 */
async function sendRuntimeCommandEvent(sock, chatId, event, options, reactionRuntime, sendOptions) {
  const commandEvent = event.event;
  if (
    commandEvent.type !== "command.started"
    && commandEvent.type !== "command.completed"
    && commandEvent.type !== "command.failed"
  ) {
    throw new Error(`Expected command runtime event, got ${commandEvent.type}.`);
  }

  const command = commandEvent.command.command;
  const status = commandEvent.command.status;
  const summary = formatRuntimeCommandSummary(command);

  if (status === "started") {
    const text = formatRuntimeCommandText(status, summary);
    let commandStateByCommand = runtimeCommandsByChat.get(chatId);
    if (!commandStateByCommand) {
      commandStateByCommand = new Map();
      runtimeCommandsByChat.set(chatId, commandStateByCommand);
    }
    const existing = commandStateByCommand.get(command);
    if (existing) {
      return existing.handle;
    }
    const handle = await sendBlocks(sock, chatId, "plain", text, options, reactionRuntime, event, {
      editHandleStore: sendOptions.editHandleStore,
    });
    commandStateByCommand.set(command, {
      command,
      ...(handle ? { handle } : {}),
    });
    return handle;
  }

  const commandStateByCommand = runtimeCommandsByChat.get(chatId);
  const state = commandStateByCommand?.get(command);
  const text = formatRuntimeCommandText(status, summary, state?.reviewPrefix);
  if (!state?.handle) {
    if (status === "failed") {
      const detail = commandEvent.command.output ? `\n\n${commandEvent.command.output}` : "";
      return sendBlocks(sock, chatId, "error", `Command failed: \`${command}\`${detail}`, options, reactionRuntime, event, {
        editHandleStore: sendOptions.editHandleStore,
      });
    }
    return undefined;
  }

  /** @type {MessageInspectState} */
  const inspect = {
    kind: "text",
    text: commandEvent.command.output ?? "_no output_",
  };
  state.handle.setInspect(inspect);
  const updatedHandle = await updateRuntimeHandleOrSendReplacement(
    sock,
    chatId,
    state.handle,
    text,
    "plain",
    options,
    reactionRuntime,
    event,
    sendOptions,
  );
  updatedHandle?.setInspect(inspect);
  commandStateByCommand?.delete(command);
  if (!commandStateByCommand || commandStateByCommand.size === 0) {
    runtimeCommandsByChat.delete(chatId);
  }
  return updatedHandle;
}

/**
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} chatId
 * @param {RuntimeEventOutboundEvent} event
 * @param {{ quoted?: BaileysMessage } | undefined} options
 * @param {import("../runtime/reaction-runtime.js").ReactionRuntime | undefined} reactionRuntime
 * @param {{ editHandleStore?: import("../../store.js").Store, outputVisibility?: import("../../chat-output-visibility.js").OutputVisibility, pinnedStatusDeliveryObserver?: PinnedStatusDeliveryObserver }} sendOptions
 * @returns {Promise<MessageHandle | undefined>}
 */
async function sendRuntimeToolEvent(sock, chatId, event, options, reactionRuntime, sendOptions) {
  const toolEvent = event.event;
  if (
    toolEvent.type !== "tool.started"
    && toolEvent.type !== "tool.updated"
    && toolEvent.type !== "tool.completed"
    && toolEvent.type !== "tool.failed"
  ) {
    throw new Error(`Expected tool runtime event, got ${toolEvent.type}.`);
  }
  if (isNoopRuntimeTool(toolEvent.tool)) {
    return undefined;
  }
  const displayTool = buildWhatsAppRuntimeToolFromRawAcp(toolEvent.tool, event);

  const status = toolEvent.type.split(".")[1];
  if (status !== "started" && status !== "updated" && status !== "completed" && status !== "failed") {
    return undefined;
  }
  const summary = formatRuntimeToolSummary(displayTool, event.cwd);
  const readRange = getRawAcpReadOutputLineRange(event);
  if (!summary) {
    return undefined;
  }

  if (status === "started") {
    const text = formatRuntimeToolText(status, summary);
    let toolStateById = runtimeToolsByChat.get(chatId);
    if (!toolStateById) {
      toolStateById = new Map();
      runtimeToolsByChat.set(chatId, toolStateById);
    }
    const existing = toolStateById.get(toolEvent.tool.id);
    if (existing) {
      return existing.handle;
    }
    const handle = await sendBlocks(sock, chatId, "plain", text, options, reactionRuntime, event, {
      editHandleStore: sendOptions.editHandleStore,
    });
    toolStateById.set(toolEvent.tool.id, {
      summary,
      ...(handle ? { handle } : {}),
    });
    return handle;
  }

  const toolStateById = runtimeToolsByChat.get(chatId);
  const state = toolStateById?.get(toolEvent.tool.id);
  const previousSummary = state?.summary;
  const effectiveSummary = summary ?? previousSummary;
  if (!effectiveSummary) {
    return undefined;
  }
  if (state) {
    const summaryBase = shouldPreserveRuntimeSummary(previousSummary, effectiveSummary)
      ? /** @type {string} */ (previousSummary)
      : effectiveSummary;
    state.summary = appendReadLineRange(summaryBase, readRange);
  }
  const text = formatRuntimeToolText(
    status,
    state?.summary ?? appendReadLineRange(effectiveSummary, readRange),
    state?.reviewPrefix,
  );
  if (state?.handle) {
    /** @type {MessageInspectState | null} */
    const inspect = toolEvent.tool.output !== undefined
      ? {
        kind: "text",
        text: toolEvent.tool.output,
      }
      : null;
    if (inspect) {
      state.handle.setInspect(inspect);
    }
    if (status === "updated" && previousSummary !== state.summary) {
      const updatedHandle = await updateRuntimeHandleOrSendReplacement(
        sock,
        chatId,
        state.handle,
        text,
        "plain",
        options,
        reactionRuntime,
        event,
        sendOptions,
      );
      if (updatedHandle) {
        state.handle = updatedHandle;
        if (inspect) {
          state.handle.setInspect(inspect);
        }
      }
    } else if (status !== "updated") {
      const updatedHandle = await updateRuntimeHandleOrSendReplacement(
        sock,
        chatId,
        state.handle,
        text,
        "plain",
        options,
        reactionRuntime,
        event,
        sendOptions,
      );
      toolStateById?.delete(toolEvent.tool.id);
      if (!toolStateById || toolStateById.size === 0) {
        runtimeToolsByChat.delete(chatId);
      }
      return updatedHandle;
    }
    return state.handle;
  }

  if (status === "updated") {
    return undefined;
  }
  return sendBlocks(sock, chatId, "plain", text, options, reactionRuntime, event, {
    editHandleStore: sendOptions.editHandleStore,
  });
}

/**
 * @returns {{
 *   entries: Array<{ id: string, summary: string, inspectDetail?: string, completed: boolean, failed: boolean }>,
 *   pendingCommandEntryIds: Map<string, string[]>,
 *   pendingToolEntryIds: string[],
 *   pendingToolEntryIdsByToolId: Map<string, string>,
 *   debounceTimer: ReturnType<typeof setTimeout> | null,
 *   nextEntryId: number,
 * }}
 */
function createCompactToolActivityState() {
  return {
    entries: [],
    pendingCommandEntryIds: new Map(),
    pendingToolEntryIds: [],
    pendingToolEntryIdsByToolId: new Map(),
    debounceTimer: null,
    nextEntryId: 0,
  };
}

/**
 * @param {{ completed: boolean, failed: boolean, summary: string, reviewPrefix?: "👍" | "👎" }} entry
 * @returns {string}
 */
function renderCompactToolActivityEntry(entry) {
  const icon = entry.failed ? "❌" : entry.completed ? "✅" : "🔧";
  const prefix = entry.reviewPrefix ? `${entry.reviewPrefix} ` : "";
  return `${prefix}${icon} ${entry.summary}`;
}

/**
 * @param {{ entries: Array<{ summary: string, inspectDetail?: string, completed: boolean, failed: boolean }> }} state
 * @returns {string}
 */
function renderCompactToolActivityText(state) {
  const hiddenCount = Math.max(0, state.entries.length - COMPACT_TOOL_ACTIVITY_LIMIT);
  const visibleEntries = hiddenCount > 0
    ? state.entries.slice(-COMPACT_TOOL_ACTIVITY_LIMIT)
    : state.entries;
  return [
    ...(hiddenCount > 0 ? [`... +${hiddenCount} earlier tools`] : []),
    ...visibleEntries.map(renderCompactToolActivityEntry),
  ].join("\n");
}

/**
 * @param {{ entries: Array<{ summary: string, inspectDetail?: string, completed: boolean, failed: boolean }> }} state
 * @returns {string}
 */
function renderCompactToolActivityInspectText(state) {
  return state.entries.map((entry) => {
    const summary = renderCompactToolActivityEntry(entry);
    return entry.inspectDetail ? `${summary}\n${entry.inspectDetail}` : summary;
  }).join("\n");
}

/**
 * @param {Map<string, string[]>} map
 * @param {string} key
 * @param {string} entryId
 * @returns {void}
 */
function rememberCompactPendingEntry(map, key, entryId) {
  const existing = map.get(key) ?? [];
  existing.push(entryId);
  map.set(key, existing);
}

/**
 * @param {Map<string, string[]>} map
 * @param {string} key
 * @returns {boolean}
 */
function hasCompactPendingEntry(map, key) {
  const existing = map.get(key);
  return Array.isArray(existing) && existing.length > 0;
}

/**
 * @param {Map<string, string[]>} map
 * @param {string} key
 * @returns {string | undefined}
 */
function consumeCompactPendingEntry(map, key) {
  const existing = map.get(key);
  if (!existing || existing.length === 0) {
    return undefined;
  }
  const entryId = existing.shift();
  if (existing.length === 0) {
    map.delete(key);
  }
  return entryId;
}

/**
 * @param {{ entries: Array<{ id: string, completed: boolean, failed: boolean }> }} state
 * @param {string | undefined} entryId
 * @param {"completed" | "failed"} status
 * @returns {boolean}
 */
function markCompactEntry(state, entryId, status) {
  if (!entryId) {
    return false;
  }
  const entry = state.entries.find((candidate) => candidate.id === entryId);
  if (!entry || entry.failed) {
    return false;
  }
  if (status === "failed") {
    entry.failed = true;
    return true;
  }
  if (entry.completed) {
    return false;
  }
  entry.completed = true;
  return true;
}

/**
 * @param {{ entries: Array<{ id: string, summary: string }> }} state
 * @param {string | undefined} entryId
 * @param {{ start: number, end: number } | null} range
 * @returns {void}
 */
function updateCompactReadLineRange(state, entryId, range) {
  if (!entryId || !range) {
    return;
  }
  const entry = state.entries.find((candidate) => candidate.id === entryId);
  if (entry) {
    entry.summary = appendReadLineRange(entry.summary, range);
  }
}

/**
 * @param {{
 *   entries: Array<{ id: string, completed: boolean, failed: boolean }>,
 *   pendingToolEntryIds: string[],
 *   pendingToolEntryIdsByToolId: Map<string, string>,
 * }} state
 * @param {string} entryId
 * @returns {void}
 */
function forgetCompactPendingToolEntry(state, entryId) {
  state.pendingToolEntryIds = state.pendingToolEntryIds.filter((candidate) => candidate !== entryId);
  for (const [toolId, candidateEntryId] of state.pendingToolEntryIdsByToolId.entries()) {
    if (candidateEntryId === entryId) {
      state.pendingToolEntryIdsByToolId.delete(toolId);
    }
  }
}

/**
 * @param {{ handle?: MessageHandle, entries: Array<{ summary: string, inspectDetail?: string, completed: boolean, failed: boolean }> }} state
 * @returns {void}
 */
function updateCompactToolActivityInspect(state) {
  state.handle?.setInspect({
    kind: "text",
    text: renderCompactToolActivityInspectText(state),
  });
}

/**
 * @param {ReturnType<typeof createCompactToolActivityState> & { handle?: MessageHandle }} state
 * @returns {Promise<MessageHandle | undefined>}
 */
async function flushCompactToolActivity(state) {
  if (state.debounceTimer) {
    clearTimeout(state.debounceTimer);
    state.debounceTimer = null;
  }
  if (!state.handle) {
    return undefined;
  }
  const text = renderCompactToolActivityText(state);
  updateCompactToolActivityInspect(state);
  await state.handle.update({ kind: "text", text });
  return state.handle;
}

/**
 * @param {ReturnType<typeof createCompactToolActivityState> & { handle?: MessageHandle }} state
 * @returns {void}
 */
function scheduleCompactToolActivityFlush(state) {
  if (!state.handle) {
    return;
  }
  if (state.debounceTimer) {
    clearTimeout(state.debounceTimer);
  }
  state.debounceTimer = setTimeout(() => {
    void flushCompactToolActivity(state);
  }, COMPACT_TOOL_ACTIVITY_DEBOUNCE_MS);
}

/**
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} chatId
 * @param {CompactToolActivityEvent} event
 * @param {{ quoted?: BaileysMessage } | undefined} options
 * @param {import("../runtime/reaction-runtime.js").ReactionRuntime | undefined} reactionRuntime
 * @param {{ editHandleStore?: import("../../store.js").Store, outputVisibility?: import("../../chat-output-visibility.js").OutputVisibility, pinnedStatusDeliveryObserver?: PinnedStatusDeliveryObserver }} sendOptions
 * @param {ReturnType<typeof createCompactToolActivityState> & { handle?: MessageHandle }} state
 * @param {{ id: string, summary: string, inspectDetail?: string, completed: boolean, failed: boolean }} entry
 * @returns {Promise<MessageHandle | undefined>}
 */
async function addCompactToolActivityEntry(sock, chatId, event, options, reactionRuntime, sendOptions, state, entry) {
  state.entries.push(entry);
  if (!state.handle) {
    const handle = await sendBlocks(sock, chatId, "plain", renderCompactToolActivityText(state), options, reactionRuntime, event, {
      editHandleStore: sendOptions.editHandleStore,
    });
    if (handle) {
      state.handle = handle;
    }
    updateCompactToolActivityInspect(state);
    return handle;
  }
  updateCompactToolActivityInspect(state);
  scheduleCompactToolActivityFlush(state);
  return state.handle;
}

/**
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} chatId
 * @param {CompactToolActivityEvent} event
 * @param {{ quoted?: BaileysMessage } | undefined} options
 * @param {import("../runtime/reaction-runtime.js").ReactionRuntime | undefined} reactionRuntime
 * @param {{ editHandleStore?: import("../../store.js").Store, pinnedStatusDeliveryObserver?: PinnedStatusDeliveryObserver }} sendOptions
 * @returns {Promise<MessageHandle | undefined>}
 */
async function sendCompactToolActivityEvent(sock, chatId, event, options, reactionRuntime, sendOptions) {
  let state = compactToolActivityByChat.get(chatId);
  if (!state) {
    state = createCompactToolActivityState();
    compactToolActivityByChat.set(chatId, state);
  }

  const activity = event.activity;
  if (activity.type === "close") {
    const handle = await flushCompactToolActivity(state);
    compactToolActivityByChat.delete(chatId);
    return handle;
  }

  if (activity.type === "command" && activity.status === "started") {
    if (hasCompactPendingEntry(state.pendingCommandEntryIds, activity.command)) {
      return state.handle;
    }
    const entryId = `compact-entry-${++state.nextEntryId}`;
    rememberCompactPendingEntry(state.pendingCommandEntryIds, activity.command, entryId);
    return addCompactToolActivityEntry(sock, chatId, event, options, reactionRuntime, sendOptions, state, {
      id: entryId,
      summary: formatCompactCommand(activity.command),
      completed: false,
      failed: false,
    });
  }

  if (activity.type === "file_read") {
    if (hasCompactPendingEntry(state.pendingCommandEntryIds, activity.command)) {
      return state.handle;
    }
    const entryId = `compact-entry-${++state.nextEntryId}`;
    rememberCompactPendingEntry(state.pendingCommandEntryIds, activity.command, entryId);
    return addCompactToolActivityEntry(sock, chatId, event, options, reactionRuntime, sendOptions, state, {
      id: entryId,
      summary: formatCompactRead(activity.paths, activity.line, activity.limit),
      completed: false,
      failed: false,
    });
  }

  if (activity.type === "command") {
    const entryId = consumeCompactPendingEntry(state.pendingCommandEntryIds, activity.command);
    if (markCompactEntry(state, entryId, activity.status === "failed" ? "failed" : "completed")) {
      return flushCompactToolActivity(state);
    }
    if (activity.status === "failed") {
      return addCompactToolActivityEntry(sock, chatId, event, options, reactionRuntime, sendOptions, state, {
        id: `compact-entry-${++state.nextEntryId}`,
        summary: formatCompactCommand(activity.command),
        inspectDetail: activity.output,
        completed: false,
        failed: true,
      });
    }
    return state.handle;
  }

  if (activity.type === "tool" && activity.status === "started" && activity.toolCall) {
    if (state.pendingToolEntryIdsByToolId.has(activity.toolCall.id)) {
      return state.handle;
    }
    const summary = formatCompactToolActivitySummary(activity, event.cwd);
    if (!summary) {
      return state.handle;
    }
    const entryId = `compact-entry-${++state.nextEntryId}`;
    state.pendingToolEntryIds.push(entryId);
    state.pendingToolEntryIdsByToolId.set(activity.toolCall.id, entryId);
    return addCompactToolActivityEntry(sock, chatId, event, options, reactionRuntime, sendOptions, state, {
      id: entryId,
      summary,
      completed: false,
      failed: false,
    });
  }

  if (activity.type === "tool" && activity.status === "updated" && activity.toolCall) {
    const entryId = state.pendingToolEntryIdsByToolId.get(activity.toolCall.id);
    const entry = entryId ? state.entries.find((candidate) => candidate.id === entryId) : undefined;
    const summary = formatCompactToolActivitySummary(activity, event.cwd);
    if (entry && summary) {
      const summaryBase = shouldPreserveRuntimeSummary(entry.summary, summary) ? entry.summary : summary;
      const nextSummary = appendReadLineRange(summaryBase, lineLimitToRange(activity.readLine, activity.readLimit));
      if (nextSummary !== entry.summary) {
        entry.summary = nextSummary;
        return flushCompactToolActivity(state);
      }
    }
    return state.handle;
  }

  if (activity.type === "tool") {
    let entryId = activity.toolCall?.id ? state.pendingToolEntryIdsByToolId.get(activity.toolCall.id) : undefined;
    if (!entryId && activity.status === "failed") {
      while (state.pendingToolEntryIds.length > 0 && !entryId) {
        entryId = state.pendingToolEntryIds.pop();
      }
    }
    updateCompactReadLineRange(state, entryId, lineLimitToRange(activity.readLine, activity.readLimit));
    if (entryId && markCompactEntry(state, entryId, activity.status === "failed" ? "failed" : "completed")) {
      forgetCompactPendingToolEntry(state, entryId);
      return flushCompactToolActivity(state);
    }
  }

  return state.handle;
}

/**
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} chatId
 * @param {{ quoted?: BaileysMessage } | undefined} options
 * @param {import("../runtime/reaction-runtime.js").ReactionRuntime | undefined} reactionRuntime
 * @param {{ editHandleStore?: import("../../store.js").Store, outputVisibility?: import("../../chat-output-visibility.js").OutputVisibility, pinnedStatusDeliveryObserver?: PinnedStatusDeliveryObserver }} sendOptions
 * @returns {Promise<MessageHandle | undefined>}
 */
async function closeCompactToolActivityIfOpen(sock, chatId, options, reactionRuntime, sendOptions) {
  if (!compactToolActivityByChat.has(chatId)) {
    return undefined;
  }
  return sendCompactToolActivityEvent(sock, chatId, {
    kind: "compact_tool_activity",
    activity: { type: "close" },
  }, options, reactionRuntime, sendOptions);
}

/**
 * @param {{ entries: Array<{ icon: string, provider: string, summary: string, detail?: string }> }} state
 * @returns {string}
 */
function renderRuntimeStatusText(state) {
  const hiddenCount = Math.max(0, state.entries.length - 3);
  const visibleEntries = hiddenCount > 0 ? state.entries.slice(-3) : state.entries;
  return [
    ...(hiddenCount > 0 ? [`... +${hiddenCount} earlier events`] : []),
    ...visibleEntries.map((entry) => `${entry.icon} *${entry.provider}*  ${entry.summary}`),
  ].join("\n");
}

/**
 * @param {{ entries: Array<{ icon: string, provider: string, summary: string, detail?: string }> }} state
 * @returns {string}
 */
function renderRuntimeStatusInspectText(state) {
  return state.entries
    .map((entry) => {
      const summary = `${entry.icon} *${entry.provider}*  ${entry.summary}`;
      return entry.detail ? `${summary}\n${entry.detail}` : summary;
    })
    .join("\n");
}

/**
 * @param {{ icon: string, provider?: string, summary: string }} entry
 * @returns {string}
 */
function renderPinnedStatusLine(entry) {
  return entry.provider
    ? `${entry.icon} *${entry.provider}*  ${entry.summary}`
    : `${entry.icon} ${entry.summary}`;
}

/**
 * @param {string} text
 * @returns {string}
 */
function truncatePinnedStatusLine(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  return firstLine.length > 100 ? `${firstLine.slice(0, 97)}...` : firstLine;
}

/**
 * @param {string} cost
 * @returns {boolean}
 */
function isZeroPinnedUsageCost(cost) {
  const numeric = Number.parseFloat(cost.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(numeric) && numeric === 0;
}

/**
 * @param {{ entries: Array<{ key: string }> } | undefined} state
 * @returns {boolean}
 */
function latestPinnedStatusEntryIsAction(state) {
  const key = state?.entries.at(-1)?.key;
  return typeof key === "string" && (key.startsWith("command:") || key.startsWith("tool:"));
}

/**
 * @param {{ entries: Array<{ key: string }> } | undefined} state
 * @returns {boolean}
 */
function pinnedStatusContainsOnlyTurnAndActions(state) {
  return !!state && state.entries.every((entry) => (
    entry.key === "turn"
    || entry.key.startsWith("command:")
    || entry.key.startsWith("tool:")
  ));
}

/**
 * @param {Array<{ key: string, icon: string, provider?: string, summary: string }>} entries
 * @returns {string}
 */
function renderPinnedTurnStatusText(entries) {
  const latestEntry = entries.at(-1);
  return latestEntry ? truncatePinnedStatusLine(renderPinnedStatusLine(latestEntry)) : "";
}

/**
 * @param {{ entries: Array<{ key: string, icon: string, provider?: string, summary: string }> }} state
 * @param {{ key: string, icon: string, provider?: string, summary: string }} entry
 * @returns {void}
 */
function upsertPinnedTurnStatusEntry(state, entry) {
  const index = state.entries.findIndex((existing) => existing.key === entry.key);
  if (index === -1) {
    state.entries.push(entry);
    return;
  }
  state.entries.splice(index, 1);
  state.entries.push(entry);
}

/**
 * @param {{ entries: Array<{ key: string, icon: string, provider?: string, summary: string }> }} state
 * @param {string} key
 * @param {string} prefix
 * @param {string} fallback
 * @returns {string}
 */
function getPreviousPinnedStatusDetail(state, key, prefix, fallback) {
  const previous = state.entries.find((entry) => entry.key === key)?.summary;
  if (previous?.startsWith(prefix)) {
    return previous.slice(prefix.length);
  }
  return fallback;
}

/**
 * @param {RuntimeEventOutboundEvent} event
 * @param {{ entries: Array<{ key: string, icon: string, provider?: string, summary: string }> } | undefined} state
 * @returns {{ key: string, icon: string, provider?: string, summary: string, closesStatus?: boolean, createsStatus?: boolean } | null}
 */
function formatPinnedRuntimeStatusPresentation(event, state) {
  const runtimeEvent = event.event;
  const provider = formatRuntimeProvider(runtimeEvent.provider);
  if (runtimeEvent.type === "reasoning.started" || runtimeEvent.type === "reasoning.updated") {
    if (!state || state.entries.some((entry) => entry.key === "thinking")) {
      return null;
    }
    return {
      key: "thinking",
      icon: "💭",
      provider: "LLM",
      summary: "thinking",
    };
  }

  if (
    runtimeEvent.type === "tool.started"
    || runtimeEvent.type === "tool.updated"
    || runtimeEvent.type === "tool.completed"
    || runtimeEvent.type === "tool.failed"
  ) {
    if (!state || isNoopRuntimeTool(runtimeEvent.tool)) {
      return null;
    }
    const displayTool = buildWhatsAppRuntimeToolFromRawAcp(runtimeEvent.tool, event);
    if (formatRuntimeToolSummary(displayTool, event.cwd)) {
      return null;
    }
    if (isLowSignalPinnedRuntimeTool(displayTool)) {
      return null;
    }
    const status = runtimeEvent.type.split(".")[1];
    if (status !== "started" && status !== "updated" && status !== "completed" && status !== "failed") {
      return null;
    }
    const key = getPinnedRuntimeToolKey(displayTool);
    const previousSummary = state.entries.find((entry) => entry.key === key)?.summary;
    const summary = formatPinnedRuntimeToolSummary(displayTool, event.cwd);
    if (!summary) {
      return null;
    }
    const summaryBase = previousSummary && shouldPreserveRuntimeSummary(previousSummary, summary)
      ? previousSummary
      : summary;
    return {
      key,
      icon: getRuntimeToolIcon(status),
      summary: appendReadLineRange(summaryBase, getRawAcpReadOutputLineRange(event)),
    };
  }

  if (
    runtimeEvent.type === "command.started"
    || runtimeEvent.type === "command.completed"
    || runtimeEvent.type === "command.failed"
  ) {
    return null;
  }

  if (runtimeEvent.type === "file-change.completed") {
    if (!state) {
      return null;
    }
    const displayPath = shortenPath(runtimeEvent.change.path, event.cwd ?? null);
    const title = runtimeEvent.change.source === "snapshot" ? "Snapshot" : "File";
    return {
      key: `file-change:${runtimeEvent.change.path}`,
      icon: "📝",
      summary: formatRuntimeProgressEntry(title, `\`${displayPath}\``),
    };
  }

  switch (runtimeEvent.type) {
    case "request.opened":
      if (!state) {
        return null;
      }
      return {
        key: `request:${runtimeEvent.request.id}`,
        icon: "⏳",
        provider,
        summary: `approval needed: ${runtimeEvent.request.summary ?? runtimeEvent.request.kind}`,
      };
    case "request.resolved":
      if (!state) {
        return null;
      }
      {
        const key = `request:${runtimeEvent.request.id}`;
        const detail = getPreviousPinnedStatusDetail(
          state,
          key,
          "approval needed: ",
          runtimeEvent.request.summary ?? runtimeEvent.request.kind,
        );
        return {
          key,
          icon: "✅",
          provider,
          summary: `approval resolved: ${detail}`,
        };
      }
    case "user-input.requested": {
      if (!state) {
        return null;
      }
      const question = runtimeEvent.request.questions.map((entry) => entry.question).filter(Boolean).join("; ");
      return {
        key: `user-input:${runtimeEvent.request.id}`,
        icon: "⏳",
        provider,
        summary: `input needed${question ? `: ${question}` : ""}`,
      };
    }
    case "user-input.resolved":
      if (!state) {
        return null;
      }
      {
        const key = `user-input:${runtimeEvent.request.id}`;
        const detail = getPreviousPinnedStatusDetail(state, key, "input needed: ", "");
        return {
          key,
          icon: "✅",
          provider,
          summary: `input resolved${detail ? `: ${detail}` : ""}`,
        };
      }
    case "model.rerouted":
      if (!state) {
        return null;
      }
      return {
        key: "model",
        icon: "🔀",
        provider,
        summary: `model ${runtimeEvent.fromModel ?? "default"} -> ${runtimeEvent.toModel ?? "default"}`,
      };
    case "config.warning":
    case "runtime.warning":
      if (!state) {
        return null;
      }
      return {
        key: `${runtimeEvent.type}:${runtimeEvent.summary ?? runtimeEvent.message ?? ""}`,
        icon: "⚠️",
        provider,
        summary: runtimeEvent.summary ?? runtimeEvent.message ?? runtimeEvent.type,
      };
    case "runtime.error":
      if (!state) {
        return null;
      }
      return {
        key: "runtime.error",
        icon: "❌",
        provider,
        summary: runtimeEvent.summary ?? runtimeEvent.message ?? runtimeEvent.details ?? "runtime error",
      };
    case "turn.started":
      return {
        key: "turn",
        icon: "🔄",
        provider,
        summary: `turn ${runtimeEvent.turn.status ?? "started"}`,
        createsStatus: true,
      };
    case "turn.completed":
      return {
        key: "turn",
        icon: "✅",
        provider,
        summary: `turn ${runtimeEvent.turn.status ?? "completed"}`,
        closesStatus: true,
      };
    default:
      return null;
  }
}

/**
 * @param {OutboundEvent} event
 * @param {{ entries: Array<{ key: string, icon: string, provider?: string, summary: string }> } | undefined} state
 * @returns {{ key: string, icon: string, provider?: string, summary: string, closesStatus?: boolean, createsStatus?: boolean } | null}
 */
function formatPinnedStatusPresentation(event, state) {
  if (event.kind === "runtime_event") {
    return formatPinnedRuntimeStatusPresentation(event, state);
  }
  if (!state) {
    return null;
  }
  switch (event.kind) {
    case "content": {
      if (event.source !== "llm" || !Array.isArray(event.content)) {
        return null;
      }
      const text = event.content
        .map((block) => block.type === "text" || block.type === "markdown" ? block.text : "")
        .join("\n")
        .trim();
      if (text !== "Thinking...") {
        return null;
      }
      return {
        key: "thinking",
        icon: "💭",
        provider: "LLM",
        summary: "thinking",
      };
    }
    case "plan":
      return {
        key: "plan",
        icon: "📋",
        provider: "PLAN",
        summary: event.presentation.summary,
      };
    case "subagent_message":
      return {
        key: `subagent:${event.threadId ?? event.agentNickname ?? "message"}`,
        icon: "🧵",
        provider: "SUBAGENT",
        summary: event.agentNickname ? `${event.agentNickname} replied` : "subagent replied",
      };
    case "usage":
      if (
        isZeroPinnedUsageCost(event.cost)
        && latestPinnedStatusEntryIsAction(state)
        && pinnedStatusContainsOnlyTurnAndActions(state)
      ) {
        return null;
      }
      return {
        key: "usage",
        icon: "📊",
        provider: "USAGE",
        summary: `cost ${event.cost}`,
      };
    case "file_change": {
      const displayPath = shortenPath(event.path, event.cwd ?? null);
      const title = event.source === "snapshot" ? "Snapshot" : "File";
      return {
        key: `file-change:${event.path}`,
        icon: "📝",
        summary: formatRuntimeProgressEntry(title, `\`${displayPath}\``),
      };
    }
    default:
      return null;
  }
}

/**
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} chatId
 * @param {OutboundEvent} event
 * @param {{ quoted?: BaileysMessage } | undefined} options
 * @param {import("../runtime/reaction-runtime.js").ReactionRuntime | undefined} reactionRuntime
 * @param {{ editHandleStore?: import("../../store.js").Store, pinnedStatusDeliveryObserver?: PinnedStatusDeliveryObserver }} sendOptions
 * @returns {Promise<MessageHandle | undefined>}
 */
async function updatePinnedTurnStatus(sock, chatId, event, options, reactionRuntime, sendOptions) {
  let state = turnStatusByChat.get(chatId);
  const presentation = formatPinnedStatusPresentation(event, state);
  if (!presentation) {
    return undefined;
  }

  if (!state && !presentation.createsStatus) {
    return undefined;
  }
  if (!state) {
    state = { entries: [] };
    turnStatusByChat.set(chatId, state);
  }

  upsertPinnedTurnStatusEntry(state, presentation);
  const text = renderPinnedTurnStatusText(state.entries);
  if (!state.handle) {
    state.handle = await sendBlocks(sock, chatId, "plain", text, options, reactionRuntime, event, {
      editHandleStore: sendOptions.editHandleStore,
    });
    observePinnedStatusDelivery(sendOptions.pinnedStatusDeliveryObserver, {
      type: "status.created",
      chatId,
      messageId: getMessageKeyId(state.handle?.messageKey),
      firstLine: getFirstLine(text),
      text,
    });
    await pinWhatsAppMessage(sock, chatId, state.handle?.messageKey, sendOptions.pinnedStatusDeliveryObserver);
  } else {
    try {
      await state.handle.update({ kind: "text", text });
      observePinnedStatusDelivery(sendOptions.pinnedStatusDeliveryObserver, {
        type: "status.edited",
        chatId,
        messageId: getMessageKeyId(state.handle.messageKey),
        firstLine: getFirstLine(text),
        text,
      });
    } catch (error) {
      if (!isStaleWhatsAppEditHandleError(error)) {
        throw error;
      }
      const staleHandle = state.handle;
      state.handle = await sendBlocks(sock, chatId, "plain", text, options, reactionRuntime, event, {
        editHandleStore: sendOptions.editHandleStore,
      });
      observePinnedStatusDelivery(sendOptions.pinnedStatusDeliveryObserver, {
        type: "status.created",
        chatId,
        messageId: getMessageKeyId(state.handle?.messageKey),
        firstLine: getFirstLine(text),
        text,
      });
      await pinWhatsAppMessage(sock, chatId, state.handle?.messageKey, sendOptions.pinnedStatusDeliveryObserver);
      if (getMessageKeyId(staleHandle.messageKey) !== getMessageKeyId(state.handle?.messageKey)) {
        await unpinWhatsAppMessage(sock, chatId, staleHandle.messageKey, sendOptions.pinnedStatusDeliveryObserver);
      }
    }
  }

  if (presentation.closesStatus) {
    await unpinWhatsAppMessage(sock, chatId, state.handle?.messageKey, sendOptions.pinnedStatusDeliveryObserver);
    turnStatusByChat.delete(chatId);
  }
  return state.handle;
}

/**
 * @param {string} prefix
 * @param {string} text
 * @returns {string}
 */
function prependSourcePrefix(prefix, text) {
  return prefix ? `${prefix} ${text}` : text;
}

/**
 * @param {import("../../message-renderer.js").SendInstruction} instruction
 * @param {string} chatId
 * @returns {Record<string, unknown>}
 */
function summarizeAttachmentInstruction(instruction, chatId) {
  const summary = {
    chatId,
    kind: instruction.kind,
  };

  switch (instruction.kind) {
    case "image":
      return {
        ...summary,
        bytes: instruction.image.byteLength,
        ...(instruction.caption ? { caption: instruction.caption } : {}),
        ...(instruction.debug ?? {}),
      };
    case "video":
      return {
        ...summary,
        bytes: instruction.video.byteLength,
        mimetype: instruction.mimetype,
        ...(instruction.caption ? { caption: instruction.caption } : {}),
        ...(instruction.debug ?? {}),
      };
    case "audio":
      return {
        ...summary,
        bytes: instruction.audio.byteLength,
        mimetype: instruction.mimetype,
        ...(instruction.debug ?? {}),
      };
    case "file":
      return {
        ...summary,
        bytes: instruction.file.byteLength,
        mimetype: instruction.mimetype,
        fileName: instruction.fileName,
        ...(instruction.caption ? { caption: instruction.caption } : {}),
        ...(instruction.debug ?? {}),
      };
    default:
      return summary;
  }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function formatErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Format inspect text for editing into a WhatsApp message with truncation.
 * @param {string} summary
 * @param {string} text
 * @returns {string}
 */
function formatInspectEditText(summary, text) {
  const MAX = 3000;
  const display = text.length <= MAX ? text
    : text.slice(0, MAX) + `\n\n_… truncated (${text.length.toLocaleString()} chars total)_`;
  return summary ? `${summary}\n\n${display}` : display;
}

/**
 * @param {string | undefined} summary
 * @param {string} rawPath
 * @param {string} displayPath
 * @param {"add" | "delete" | "update" | undefined} kind
 * @returns {string | undefined}
 */
function cleanFileChangeSummary(summary, rawPath, displayPath, kind) {
  if (!summary) {
    return undefined;
  }

  const shortenedSummary = summary.split(rawPath).join(displayPath);
  const genericSummaries = new Set([
    "ACP file change",
    "ACP file delete",
    "ACP file write",
    "Editing files",
  ]);
  if (genericSummaries.has(shortenedSummary)) {
    return undefined;
  }
  const redundantForms = new Set([
    rawPath,
    displayPath,
    ...(kind ? [`${rawPath} (${kind})`, `${displayPath} (${kind})`] : []),
  ]);

  return redundantForms.has(shortenedSummary) ? undefined : shortenedSummary;
}

/**
 * @param {FileChangeEvent} event
 * @param {"add" | "delete" | "update" | undefined} displayKind
 * @returns {string}
 */
function getFileChangeTitle(event, displayKind) {
  if (event.stage === "proposed") {
    return "*Proposed File Change*";
  }
  if (event.stage === "denied") {
    return "*Denied File Change*";
  }
  if (event.stage === "failed") {
    return "*Failed File Change*";
  }
  if (event.source === "snapshot") {
    return "Snapshot";
  }
  if (displayKind === "add") {
    return "Add";
  }
  if (displayKind === "delete") {
    return "Delete";
  }
  return "Update";
}

/**
 * @param {string} title
 * @param {string} displayPath
 * @returns {string}
 */
function formatFileChangeCaptionLine(title, displayPath) {
  const displayTitle = title.startsWith("*") ? title : `*${title}*`;
  return `${displayTitle}  \`${displayPath}\``;
}

/**
 * @param {FileChangeEvent} event
 * @returns {"add" | "delete" | "update" | undefined}
 */
function inferDisplayedFileChangeKind(event) {
  const diffKind = inferFileChangeKindFromDiff(event.diff);
  if (diffKind === "add" || diffKind === "delete") {
    return diffKind;
  }

  if (event.changeKind === "add" && typeof event.newText === "string") {
    if (typeof event.oldText === "string" && event.oldText.length > 0) {
      return "update";
    }
    return "add";
  }

  if (typeof event.oldText === "string" && typeof event.newText === "string") {
    if (event.oldText !== event.newText) {
      if (event.oldText.length === 0 && event.newText.length > 0 && event.changeKind === "add") {
        return "add";
      }
      return "update";
    }
  } else if (typeof event.oldText === "string") {
    return "delete";
  } else if (typeof event.newText === "string") {
    return "add";
  }

  return diffKind ?? event.changeKind;
}

/**
 * Render added files as source code instead of a diff, even when stale
 * previous text is attached to the event.
 * @param {FileChangeEvent} event
 * @param {"add" | "delete" | "update" | undefined} displayKind
 * @returns {boolean}
 */
function shouldRenderFileChangeAsCode(event, displayKind) {
  if (displayKind !== "add" || typeof event.newText !== "string") {
    return false;
  }
  return true;
}

/**
 * @param {string | undefined} diffText
 * @returns {"add" | "delete" | "update" | undefined}
 */
function inferFileChangeKindFromDiff(diffText) {
  if (!diffText) {
    return undefined;
  }

  for (const line of diffText.split("\n")) {
    if (line.startsWith("--- ")) {
      if (line.includes("/dev/null")) {
        return "add";
      }
      continue;
    }
    if (line.startsWith("+++ ") && line.includes("/dev/null")) {
      return "delete";
    }
  }

  return undefined;
}

/**
 * Keep hunk headers visible, but drop file header lines from rendered diffs.
 * @param {string | undefined} diffText
 * @returns {string | undefined}
 */
function stripUnifiedDiffFileHeaders(diffText) {
  if (!diffText) {
    return undefined;
  }

  const lines = diffText.split("\n");
  const filtered = lines.filter((line) => !line.startsWith("--- ") && !line.startsWith("+++ "));
  return filtered.join("\n");
}

/**
 * @param {FileChangeEvent} event
 * @returns {string | undefined}
 */
function buildSnapshotFileChangeDiffText(event) {
  if (event.diff) {
    return stripUnifiedDiffFileHeaders(event.diff);
  }
  if (typeof event.oldText === "string" || typeof event.newText === "string") {
    return buildContextualUnifiedDiff(event.oldText ?? "", event.newText ?? "");
  }
  return undefined;
}

/**
 * @param {string} diffText
 * @returns {string[]}
 */
function splitSnapshotDiffText(diffText) {
  const lines = diffText.split("\n");
  if (lines.length <= SNAPSHOT_DIFF_LINES_PER_BATCH) {
    return [diffText];
  }

  /** @type {string[]} */
  const batches = [];
  for (let index = 0; index < lines.length; index += SNAPSHOT_DIFF_LINES_PER_BATCH) {
    batches.push(lines.slice(index, index + SNAPSHOT_DIFF_LINES_PER_BATCH).join("\n"));
  }
  return batches;
}

/**
 * @param {string} diffText
 * @returns {number}
 */
function countDiffLines(diffText) {
  return diffText === "" ? 0 : diffText.split("\n").length;
}

/**
 * @param {FileChangeEvent} event
 * @returns {SendContent}
 */
export function renderFileChangeContent(event) {
  const displayPath = shortenPath(event.path, event.cwd ?? null);
  const displayKind = inferDisplayedFileChangeKind(event);
  const cleanedSummary = cleanFileChangeSummary(event.summary, event.path, displayPath, displayKind);
  const title = getFileChangeTitle(event, displayKind);
  const captionLines = [formatFileChangeCaptionLine(title, displayPath)];
  if (cleanedSummary) {
    captionLines.push(cleanedSummary);
  }

  if (shouldRenderFileChangeAsCode(event, displayKind)) {
    const newText = event.newText;
    if (typeof newText !== "string") {
      return `Changed file: \`${displayPath}\``;
    }
    return [{
      type: "code",
      code: newText,
      language: langFromPath(event.path) || "text",
      caption: captionLines.join("\n"),
    }];
  }

  if (event.diff) {
    return [{
      type: "diff",
      oldStr: event.oldText ?? "",
      newStr: event.newText ?? "",
      diffText: stripUnifiedDiffFileHeaders(event.diff),
      language: langFromPath(event.path) || "text",
      caption: captionLines.join("\n"),
    }];
  }

  if (typeof event.oldText === "string" || typeof event.newText === "string") {
    return [{
      type: "diff",
      oldStr: "",
      newStr: "",
      diffText: buildContextualUnifiedDiff(event.oldText ?? "", event.newText ?? ""),
      language: langFromPath(event.path) || "text",
      caption: captionLines.join("\n"),
    }];
  }

  return captionLines.join("\n");
}

/**
 * @param {OutboundEvent} event
 * @returns {{ source: MessageSource, content: SendContent, cwd?: string | null } | null}
 */
function renderOutboundEvent(event) {
  switch (event.kind) {
    case "content":
      return {
        source: event.source,
        content: event.content,
        ...(event.cwd !== undefined && { cwd: event.cwd }),
      };
    case "tool_call": {
      const presentation = buildToolPresentationFromToolCallEvent(event);
      return presentation
        ? { source: "tool-call", content: renderToolPresentationContent(presentation) }
        : null;
    }
    case "tool_activity":
      return shouldSuppressToolActivity(event.activity)
        ? null
        : { source: "tool-call", content: renderToolActivityContent(event.activity) };
    case "plan":
      return { source: "llm", content: [{ type: "markdown", text: formatPlanPresentationText(event.presentation) }] };
    case "file_change":
      return { source: "tool-call", content: renderFileChangeContent(event) };
    case "usage":
      return {
        source: "usage",
        content: formatUsageEventText(event),
      };
    case "subagent_message":
      return {
        source: "plain",
        content: renderSubagentMessageContent(event),
      };
    default:
      return null;
  }
}

/**
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} chatId
 * @param {RuntimeEventOutboundEvent} event
 * @param {{ quoted?: BaileysMessage } | undefined} options
 * @param {import("../runtime/reaction-runtime.js").ReactionRuntime | undefined} reactionRuntime
 * @param {{ editHandleStore?: import("../../store.js").Store, outputVisibility?: import("../../chat-output-visibility.js").OutputVisibility, pinnedStatusDeliveryObserver?: PinnedStatusDeliveryObserver }} [sendOptions]
 * @returns {Promise<MessageHandle | undefined>}
 */
async function sendRuntimeEvent(sock, chatId, event, options, reactionRuntime, sendOptions = {}) {
  const turnStatusHandle = await updatePinnedTurnStatus(sock, chatId, event, options, reactionRuntime, sendOptions);
  if (event.event.type === "turn.started" || event.event.type === "turn.completed") {
    if (event.event.type === "turn.completed") {
      runtimeStatusByChat.delete(chatId);
    }
    return turnStatusHandle;
  }

  if (event.event.type === "reasoning.started" || event.event.type === "reasoning.updated" || event.event.type === "reasoning.completed") {
    return turnStatusHandle;
  }

  if (event.event.type === "tool.started" || event.event.type === "tool.updated" || event.event.type === "tool.completed" || event.event.type === "tool.failed") {
    return sendRuntimeToolEvent(sock, chatId, event, options, reactionRuntime, sendOptions);
  }

  if (event.event.type === "command.started" || event.event.type === "command.completed" || event.event.type === "command.failed") {
    return sendRuntimeCommandEvent(sock, chatId, event, options, reactionRuntime, sendOptions);
  }

  if (event.event.type === "file-change.completed") {
    return sendRuntimeFileChangeEvent(sock, chatId, event, options, reactionRuntime, sendOptions);
  }

  if (shouldSuppressRuntimeEvent(event.event)) {
    return undefined;
  }

  await closeCompactToolActivityIfOpen(sock, chatId, options, reactionRuntime, sendOptions);

  const presentation = formatRuntimeEventPresentation(event.event);
  if (presentation.kind === "error") {
    return sendBlocks(sock, chatId, "error", presentation.summary, options, reactionRuntime, event, {
      editHandleStore: sendOptions.editHandleStore,
    });
  }

  const state = runtimeStatusByChat.get(chatId) ?? { entries: [] };
  state.entries.push({
    icon: presentation.icon,
    provider: presentation.provider,
    summary: presentation.summary,
    ...(presentation.detail ? { detail: presentation.detail } : {}),
  });
  runtimeStatusByChat.set(chatId, state);
  const text = renderRuntimeStatusText(state);
  if (!state.handle) {
    state.handle = await sendBlocks(sock, chatId, "plain", text, options, reactionRuntime, event, {
      editHandleStore: sendOptions.editHandleStore,
    });
  } else {
    try {
      await state.handle.update({ kind: "text", text });
    } catch (error) {
      if (!isStaleWhatsAppEditHandleError(error)) {
        throw error;
      }
      state.handle = await sendBlocks(sock, chatId, "plain", text, options, reactionRuntime, event, {
        editHandleStore: sendOptions.editHandleStore,
      });
    }
  }
  state.handle?.setInspect({
    kind: "text",
    text: renderRuntimeStatusInspectText(state),
  });
  if (presentation.closesStatus) {
    runtimeStatusByChat.delete(chatId);
  }
  return state.handle;
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isStaleWhatsAppEditHandleError(error) {
  if (!(error instanceof Error)) {
    return false;
  }
  return /^WhatsApp edit handle .+ (expired|was not found)\.$/.test(error.message);
}

/**
 * @param {MessageHandleUpdate} update
 * @returns {string}
 */
function summarizeHandleUpdate(update) {
  switch (update.kind) {
    case "text":
      return update.text;
    case "tool_call":
      return formatToolPresentationSummary(update.presentation);
    case "tool_flow":
      return formatToolFlowSummary(update.state);
    default:
      return "";
  }
}

/**
 * @param {MessageInspectState} inspect
 * @returns {{ summary: string, text: string }}
 */
function formatInspectState(inspect) {
  switch (inspect.kind) {
    case "tool": {
      const summary = formatToolPresentationSummary(inspect.presentation);
      const text = formatToolPresentationInspect(inspect.presentation, inspect.output) ?? "_no output_";
      return { summary, text };
    }
    case "tool_flow":
      return {
        summary: formatToolFlowSummary(inspect.state),
        text: formatToolFlowInspectText(inspect.state, formatToolPresentationInspect),
      };
    case "reasoning":
      return {
        summary: inspect.summary,
        text: inspect.text,
      };
    case "text":
      return {
        summary: "",
        text: inspect.text,
      };
    default:
      return { summary: "", text: "_no output_" };
  }
}

/**
 * Send multiple images as a WhatsApp album using raw protocol messages.
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} chatId
 * @param {Array<{ image: Buffer, caption?: string }>} items
 * @param {{ quoted?: BaileysMessage }} [options]
 * @returns {Promise<import('@whiskeysockets/baileys').WAMessageKey | undefined>}
 */
export async function sendAlbum(sock, chatId, items, options) {
  const userJid = sock.user?.id;

  if (items.length === 0) return undefined;
  if (items.length === 1) {
    const sent = await sendObservedWhatsAppMessage(sock, chatId, makeImageMessage(items[0].image, items[0].caption), options ?? {});
    return sent?.key;
  }

  const albumMsgId = generateMessageIDV2(userJid);
  const albumMsg = generateWAMessageFromContent(
    chatId,
    /** @type {import('@whiskeysockets/baileys').WAMessageContent} */ ({
      albumMessage: {
        expectedImageCount: items.length,
        expectedVideoCount: 0,
      },
      messageContextInfo: { messageSecret: randomBytes(32) },
    }),
    {
      userJid: userJid ?? "",
      messageId: albumMsgId,
      ...(options?.quoted && { quoted: options.quoted }),
    },
  );
  if (!albumMsg.message) throw new Error("Failed to generate album header message");

  await relayObservedWhatsAppMessage(sock, chatId, albumMsg.message, { messageId: albumMsgId });

  const parentMessageKey = {
    remoteJid: albumMsg.key.remoteJid,
    fromMe: albumMsg.key.fromMe,
    id: albumMsg.key.id,
  };

  const uploadOpts = { upload: sock.waUploadToServer, userJid: userJid ?? "" };
  const uploaded = await Promise.all(
    items.map((item) => generateWAMessage(
      chatId,
      makeImageMessage(item.image, item.caption),
      uploadOpts,
    )),
  );

  /** @type {import('@whiskeysockets/baileys').WAMessageKey | undefined} */
  let firstMediaKey;

  for (let index = 0; index < uploaded.length; index++) {
    const imageMessage = uploaded[index];
    if (!imageMessage.message) throw new Error(`Failed to generate image message ${index}`);

    imageMessage.message.messageContextInfo = {
      messageSecret: randomBytes(32),
      messageAssociation: {
        associationType: proto.MessageAssociation.AssociationType.MEDIA_ALBUM,
        parentMessageKey,
        messageIndex: index,
      },
    };

    await relayObservedWhatsAppMessage(sock, chatId, imageMessage.message, {
      messageId: /** @type {string} */ (imageMessage.key.id),
    });

    if (index === 0) {
      firstMediaKey = imageMessage.key;
    }

    if (index < uploaded.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, ALBUM_RELAY_DELAY_MS));
    }
  }

  return firstMediaKey;
}

/**
 * Edit a previously sent WhatsApp message.
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} jid
 * @param {string} newText
 * @param {{ messageKey?: import('@whiskeysockets/baileys').WAMessageKey, messageKind?: "text" | "image", fallbackKeyId?: string }} target
 * @returns {Promise<void>}
 */
export async function editWhatsAppMessage(sock, jid, newText, target) {
  const resolved = resolveWhatsAppEditTarget(target, { chatId: jid });
  if (!resolved) {
    throw new Error("Cannot edit WhatsApp message without an edit target.");
  }
  if (resolved.messageKind === "image") {
    await relayObservedWhatsAppMessage(sock, jid, {
      protocolMessage: {
        key: resolved.key,
        type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
        editedMessage: { imageMessage: { caption: newText } },
      },
    }, { additionalAttributes: { edit: "1" } });
    return;
  }

  await sendObservedWhatsAppMessage(sock, jid, makeTextMessage(newText, { edit: resolved.key }), undefined);
}

/**
 * Edit through a WhatsApp-owned durable handle.
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} transportHandleId
 * @param {string} newText
 * @param {{ store?: import("../../store.js").Store, now?: Date }} [options]
 * @returns {Promise<void>}
 */
export async function editWhatsAppMessageByHandle(sock, transportHandleId, newText, options = {}) {
  const record = await resolveWhatsAppEditHandle(transportHandleId, options.store);
  if (!record) {
    throw new Error(`WhatsApp edit handle ${transportHandleId} was not found.`);
  }
  if (isExpiredWhatsAppEditHandle(record, options.now)) {
    throw new Error(`WhatsApp edit handle ${transportHandleId} expired.`);
  }
  await editWhatsAppMessage(sock, record.chatId, newText, {
    messageKey: record.messageKey,
    messageKind: record.messageKind,
  });
}

/**
 * Debounce edits for the same durable handle so rapidly changing status text
 * does not become one WhatsApp transaction per internal progress event.
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} transportHandleId
 * @param {string} newText
 * @param {{ store?: import("../../store.js").Store, trace?: Record<string, unknown>, debounceMs?: number }} [options]
 * @returns {Promise<void>}
 */
function editWhatsAppMessageByHandleDebounced(sock, transportHandleId, newText, options = {}) {
  const trace = {
    handleId: transportHandleId,
    ...options.trace,
  };
  const diagnosticChatId = typeof options.trace?.chatId === "string" ? options.trace.chatId : "";
  const diagnosticMessage = {
    text: newText,
    edit: { id: transportHandleId },
  };
  const debounceMs = typeof options.debounceMs === "number"
    ? Math.max(0, options.debounceMs)
    : getWhatsAppEditDebounceMs();
  if (debounceMs <= 0) {
    appendWhatsAppOutboundDiagnostic({
      transport: "messageHandle",
      phase: "immediate",
      chatId: diagnosticChatId,
      message: diagnosticMessage,
      trace,
    });
    return editWhatsAppMessageByHandle(sock, transportHandleId, newText, options);
  }

  const existing = pendingEditDebounces.get(transportHandleId);
  if (existing) {
    clearTimeout(existing.timer);
  }
  appendWhatsAppOutboundDiagnostic({
    transport: "messageHandle",
    phase: existing ? "replaced" : "queued",
    chatId: diagnosticChatId,
    message: diagnosticMessage,
    trace: {
      ...trace,
      replacedQueuedEdit: !!existing,
      queuedWaiterCount: (existing?.waiters.length ?? 0) + 1,
    },
  });

  return new Promise((resolve, reject) => {
    const waiters = existing?.waiters ?? [];
    waiters.push({ resolve, reject });
    const entry = {
      sock,
      text: newText,
      options,
      waiters,
      timer: setTimeout(() => {
        if (pendingEditDebounces.get(transportHandleId) !== entry) {
          return;
        }
        pendingEditDebounces.delete(transportHandleId);
        appendWhatsAppOutboundDiagnostic({
          transport: "messageHandle",
          phase: "flushing",
          chatId: diagnosticChatId,
          message: {
            text: entry.text,
            edit: { id: transportHandleId },
          },
          trace,
        });
        void editWhatsAppMessageByHandle(entry.sock, transportHandleId, entry.text, entry.options)
          .then(() => {
            for (const waiter of entry.waiters) {
              waiter.resolve();
            }
          })
          .catch((error) => {
            for (const waiter of entry.waiters) {
              waiter.reject(error);
            }
          });
      }, debounceMs),
    };
    pendingEditDebounces.set(transportHandleId, entry);
  });
}

/**
 * Dispatch a semantic outbound event as WhatsApp messages.
 * Returns a MessageHandle for the last editable message sent (if any).
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} chatId
 * @param {OutboundEvent} event
 * @param {{ quoted?: BaileysMessage } | undefined} options
 * @param {import("../runtime/reaction-runtime.js").ReactionRuntime | undefined} reactionRuntime
 * @param {{ editHandleStore?: import("../../store.js").Store, outputVisibility?: import("../../chat-output-visibility.js").OutputVisibility, pinnedStatusDeliveryObserver?: PinnedStatusDeliveryObserver }} [sendOptions]
 * @returns {Promise<MessageHandle | undefined>}
 */
export async function sendEvent(sock, chatId, event, options, reactionRuntime, sendOptions = {}) {
  const guardianPrefix = getGuardianReviewPrefixEmoji(event);
  if (guardianPrefix) {
    await prefixLatestToolMessage(chatId, guardianPrefix);
    return undefined;
  }
  if (event.kind === "runtime_event") {
    return sendRuntimeEvent(sock, chatId, event, options, reactionRuntime, sendOptions);
  }
  await updatePinnedTurnStatus(sock, chatId, event, options, reactionRuntime, sendOptions);
  if (event.kind === "compact_tool_activity") {
    return sendCompactToolActivityEvent(sock, chatId, event, options, reactionRuntime, sendOptions);
  }
  await closeCompactToolActivityIfOpen(sock, chatId, options, reactionRuntime, sendOptions);
  const rendered = renderOutboundEvent(event);
  if (!rendered) {
    return undefined;
  }
  return sendBlocks(sock, chatId, rendered.source, rendered.content, options, reactionRuntime, event, {
    workdir: rendered.cwd ?? null,
    editHandleStore: sendOptions.editHandleStore,
  });
}

/**
 * Dispatch SendContent as WhatsApp messages with a source-based prefix.
 * Returns a MessageHandle for the last editable message sent (if any).
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} chatId
 * @param {MessageSource} source
 * @param {SendContent} content
 * @param {{ quoted?: BaileysMessage } | undefined} options
 * @param {import("../runtime/reaction-runtime.js").ReactionRuntime | undefined} reactionRuntime
 * @param {OutboundEvent | undefined} [event]
 * @param {{ workdir?: string | null, editHandleStore?: import("../../store.js").Store, pin?: boolean, pinnedStatusDeliveryObserver?: PinnedStatusDeliveryObserver }} [renderOptions]
 * @returns {Promise<MessageHandle | undefined>}
 */
export async function sendBlocks(sock, chatId, source, content, options, reactionRuntime, event, renderOptions = {}) {
  const prefix = SOURCE_PREFIX[source];
  const blocks = typeof content === "string"
    ? [/** @type {ToolContentBlock} */ ({ type: "text", text: content })]
    : Array.isArray(content) ? content : [content];

  const instructions = await renderBlocks(blocks, prefix, renderOptions);

  /** @type {import('@whiskeysockets/baileys').WAMessageKey | undefined} */
  let lastSentKey;
  let lastSentIsImage = false;

  /**
   * @param {import("../../message-renderer.js").SendInstruction} instruction
   * @returns {Promise<void>}
   */
  async function sendInstruction(instruction) {
    /** @type {import('@whiskeysockets/baileys').WAMessage | undefined} */
    let sent;
    const isAttachmentInstruction = instruction.kind !== "text";

    if (isAttachmentInstruction) {
      log.info("Sending attachment instruction", summarizeAttachmentInstruction(instruction, chatId));
    }

    try {
      switch (instruction.kind) {
        case "text":
          sent = await sendObservedWhatsAppMessage(sock, chatId, makeTextMessage(instruction.text), options);
          if (instruction.continuation && sent?.key) {
            subscribeRenderedImagesContinuation(instruction.continuation, sent.key);
          }
          if (instruction.editable && sent?.key) {
            lastSentKey = sent.key;
            lastSentIsImage = false;
          }
          break;
        case "image":
          if (instruction.hd) {
            const imageMessage = makeImageMessage(instruction.image, instruction.caption);
            appendWhatsAppOutboundDiagnostic({
              transport: "sendMessage",
              phase: "attempt",
              chatId,
              message: imageMessage,
              options,
            });
            try {
              sent = await sendImageHD(sock, chatId, instruction.image, instruction.caption, options);
              appendWhatsAppOutboundDiagnostic({
                transport: "sendMessage",
                phase: "sent",
                chatId,
                message: imageMessage,
                resultKey: sent?.key ?? null,
                options,
              });
            } catch (error) {
              appendWhatsAppOutboundDiagnostic({
                transport: "sendMessage",
                phase: "failed",
                chatId,
                message: imageMessage,
                options,
                error: formatErrorMessage(error),
              });
              throw error;
            }
          } else {
            sent = await sendObservedWhatsAppMessage(sock, chatId, makeImageMessage(instruction.image, instruction.caption), options);
          }
          if (instruction.editable && sent?.key) {
            lastSentKey = sent.key;
            lastSentIsImage = true;
          }
          break;
        case "video":
          sent = await sendObservedWhatsAppMessage(sock, chatId, {
            video: instruction.video,
            mimetype: instruction.mimetype,
            jpegThumbnail: "",
            ...(instruction.caption && { caption: instruction.caption }),
          }, options);
          break;
        case "audio":
          sent = await sendObservedWhatsAppMessage(sock, chatId, {
            audio: instruction.audio,
            mimetype: instruction.mimetype,
          }, options);
          break;
        case "file":
          sent = await sendObservedWhatsAppMessage(sock, chatId, {
            document: instruction.file,
            mimetype: instruction.mimetype,
            fileName: instruction.fileName,
            ...(instruction.caption && { caption: instruction.caption }),
          }, options);
          break;
      }
    } catch (error) {
      if (isAttachmentInstruction) {
        log.error("Attachment instruction send failed", {
          ...summarizeAttachmentInstruction(instruction, chatId),
          error: formatErrorMessage(error),
        });
      }
      throw error;
    }

    if (isAttachmentInstruction) {
      log.info("Sent attachment instruction", {
        ...summarizeAttachmentInstruction(instruction, chatId),
        messageId: sent?.key?.id,
      });
    }
  }

  /**
   * @param {import("../../message-renderer.js").RenderedImagesContinuation} continuation
   * @param {import('@whiskeysockets/baileys').WAMessageKey} promptKey
   * @returns {void}
   */
  function subscribeRenderedImagesContinuation(continuation, promptKey) {
    const promptKeyId = promptKey.id;
    if (!reactionRuntime || typeof promptKeyId !== "string") {
      return;
    }

    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      unsubscribe();
    }, SNAPSHOT_DIFF_CONTINUATION_TIMEOUT_MS);
    timer.unref?.();

    const unsubscribe = reactionRuntime.subscribe(promptKeyId, (emoji) => {
      if (settled) {
        return;
      }
      if (emoji.startsWith("👎") || emoji.startsWith("❌")) {
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        return;
      }
      if (!emoji.startsWith("👍") && !emoji.startsWith("✅")) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      void sendRenderedImagesContinuation(continuation).catch((error) => {
        log.error("Rendered image continuation failed", {
          chatId,
          label: continuation.label,
          totalImages: continuation.totalImages,
          error: formatErrorMessage(error),
        });
        void sendObservedWhatsAppMessage(
          sock,
          chatId,
          makeTextMessage(prependSourcePrefix(prefix, `⚠️ ${continuation.label} continuation failed: ${formatErrorMessage(error)}`)),
          options,
        ).catch(() => {});
      });
    });
  }

  /**
   * @param {import("../../message-renderer.js").RenderedImagesContinuation} continuation
   * @returns {Promise<void>}
   */
  async function sendRenderedImagesContinuation(continuation) {
    const imageInstructions = await continuation.renderAll();
    if (imageInstructions.length === 0) {
      return;
    }
    if (imageInstructions.length >= 2) {
      await sendAlbum(
        sock,
        chatId,
        imageInstructions.map((image) => ({
          image: image.image,
          ...(image.caption && { caption: image.caption }),
        })),
        options,
      );
      return;
    }
    const [instruction] = imageInstructions;
    await sendInstruction(instruction);
  }

  if (instructions.filter((instruction) => instruction.kind === "image").length < 2) {
    for (const instruction of instructions) {
      await sendInstruction(instruction);
    }
  } else {
    /**
     * @typedef {{ kind: "images", items: Array<import("../../message-renderer.js").SendInstruction & { kind: "image" }> }
     *   | { kind: "single", instr: import("../../message-renderer.js").SendInstruction }} SendSegment
     */
    /** @type {SendSegment[]} */
    const segments = [];
    /** @type {Array<import("../../message-renderer.js").SendInstruction & { kind: "image" }>} */
    let imageRun = [];

    for (const instruction of instructions) {
      if (instruction.kind === "image") {
        imageRun.push(instruction);
        continue;
      }

      if (imageRun.length > 0) {
        segments.push({ kind: "images", items: imageRun });
        imageRun = [];
      }
      segments.push({ kind: "single", instr: instruction });
    }

    if (imageRun.length > 0) {
      segments.push({ kind: "images", items: imageRun });
    }

    for (const segment of segments) {
      if (segment.kind === "images" && segment.items.length >= 2) {
        const albumItems = segment.items.map((image) => ({
          image: image.image,
          ...(image.caption && { caption: image.caption }),
        }));
        const albumKey = await sendAlbum(sock, chatId, albumItems, options);
        if (albumKey && segment.items[0].editable) {
          lastSentKey = albumKey;
          lastSentIsImage = true;
        }
        continue;
      }

      await sendInstruction(segment.kind === "images" ? segment.items[0] : segment.instr);
    }
  }

  if (!lastSentKey) return undefined;

  const editKey = lastSentKey;
  const isImage = lastSentIsImage;
  const editHandle = createWhatsAppEditHandleRecord(chatId, editKey, isImage ? "image" : "text");
  await rememberWhatsAppEditHandle(editHandle, renderOptions.editHandleStore);
  if (renderOptions.pin === true) {
    await pinWhatsAppMessage(sock, chatId, editKey, renderOptions.pinnedStatusDeliveryObserver);
  }
  const transportHandleId = editHandle.id;
  /** @type {MessageInspectState | null} */
  let inspectState = event?.kind === "tool_call"
    ? (() => {
      const presentation = buildToolPresentationFromToolCallEvent(event);
      return presentation ? { kind: "tool", presentation } : null;
    })()
    : null;
  let inspectReactionSent = false;
  /** @type {"visible" | "inspect"} */
  let displayMode = "visible";
  /** @type {string | null} */
  let lastAttachedInspectText = null;
  let inspectRenderAttempt = 0;

  function reactWithInspectMarkerOnce() {
    if (inspectReactionSent || !reactionRuntime || !editKey.id) {
      return;
    }
    inspectReactionSent = true;
    void sendObservedWhatsAppMessage(sock, chatId, {
      react: { text: INSPECT_REACTION_EMOJI, key: editKey },
    }, undefined).catch((error) => {
      log.warn("Failed to add inspect reaction marker.", {
        chatId,
        messageId: editKey.id,
        error: formatErrorMessage(error),
      });
    });
  }

  /** @type {MessageHandle} */
  const handle = {
    transportHandleId,
    messageKey: editKey,
    deliveryStatus: "sent",
    waitUntilSent: async () => handle,
    update: async (update) => {
      const inspectText = displayMode === "inspect" ? formatCurrentInspectText() : null;
      const text = inspectText ?? prependSourcePrefix(prefix, summarizeHandleUpdate(update));
      await editWhatsAppMessageByHandleDebounced(
        sock,
        transportHandleId,
        text,
        {
          store: renderOptions.editHandleStore,
          trace: {
            chatId,
            cause: "handle.update",
            renderMode: inspectText ? "inspect" : "visible",
            displayMode,
            messageId: editKey.id ?? null,
          },
        },
      );
    },
    setInspect: (inspect) => {
      inspectState = inspect;
      if (inspect) {
        reactWithInspectMarkerOnce();
        const text = formatCurrentInspectText();
        if (text === lastAttachedInspectText) {
          return;
        }
        lastAttachedInspectText = text;
        appendWhatsAppOutboundDiagnostic({
          transport: "messageHandle",
          phase: "attached",
          chatId,
          message: text ? { text, edit: { id: transportHandleId } } : { text: "", edit: { id: transportHandleId } },
          trace: {
            handleId: transportHandleId,
            cause: "handle.setInspect",
            renderMode: "inspect",
            displayMode,
            messageId: editKey.id ?? null,
            inspectKind: inspect.kind,
            willEditVisibleMessage: displayMode === "inspect",
          },
        });
      }
      if (displayMode === "inspect") {
        const text = formatCurrentInspectText();
        if (text) {
          void showInspectText(text, "handle.setInspect");
        }
      }
    },
  };

  /**
   * @returns {string | null}
   */
  function formatCurrentInspectText() {
    if (!inspectState) {
      return null;
    }
    if (inspectState.kind === "text") {
      if (!inspectState.text.trim()) {
        return null;
      }
      return prependSourcePrefix(prefix, formatInspectEditText("", inspectState.text));
    }
    const inspect = formatInspectState(inspectState);
    return prependSourcePrefix(prefix, formatInspectEditText(inspect.summary, inspect.text));
  }

  /**
   * @param {string} text
   * @param {"reaction.inspect" | "handle.setInspect"} cause
   * @returns {Promise<void>}
   */
  async function showInspectText(text, cause) {
    const attempt = ++inspectRenderAttempt;
    if (isExpiredWhatsAppEditHandle(editHandle)) {
      await sendObservedWhatsAppMessage(sock, chatId, makeTextMessage(text), undefined);
      return;
    }
    try {
      await editWhatsAppMessageByHandleDebounced(
        sock,
        transportHandleId,
        text,
        {
          store: renderOptions.editHandleStore,
          trace: {
            chatId,
            cause,
            renderMode: "inspect",
            displayMode,
            messageId: editKey.id ?? null,
          },
          ...(cause === "reaction.inspect" ? { debounceMs: 1 } : {}),
        },
      );
    } catch (error) {
      if (attempt !== inspectRenderAttempt) {
        return;
      }
      log.warn("Failed to edit inspected WhatsApp message; sending inspect detail separately.", {
        chatId,
        messageId: editKey.id,
        error: formatErrorMessage(error),
      });
      await sendObservedWhatsAppMessage(sock, chatId, makeTextMessage(text), undefined);
    }
  }

  if (inspectState) {
    reactWithInspectMarkerOnce();
  }

  /**
   * @param {"handled" | "ignored"} phase
   * @param {string} reason
   * @param {string} senderId
   * @param {import("../runtime/reaction-runtime.js").ReactionMetadata} metadata
   * @returns {void}
   */
  function appendInspectReactionDecisionDiagnostic(phase, reason, senderId, metadata) {
    appendWhatsAppOutboundDiagnostic({
      transport: "messageHandle",
      phase,
      chatId,
      message: { react: { text: INSPECT_REACTION_EMOJI, key: editKey } },
      trace: {
        handleId: transportHandleId,
        cause: "reaction.inspect",
        reason,
        senderId,
        reactionFromMe: metadata.fromMe ?? null,
        selfIds: getSocketSelfIds(sock),
        inspectStatePresent: !!inspectState,
        displayMode,
        messageId: editKey.id ?? null,
      },
    });
  }

  if (editKey.id && reactionRuntime) {
    reactionRuntime.subscribe(editKey.id, (emoji, senderId, metadata) => {
      if (!emoji.startsWith(INSPECT_REACTION_EMOJI)) {
        appendInspectReactionDecisionDiagnostic("ignored", "non-inspect-reaction", senderId, metadata);
        return;
      }
      if (metadata.fromMe === true) {
        appendInspectReactionDecisionDiagnostic("ignored", "reaction-from-me", senderId, metadata);
        return;
      }
      if (isReactionFromSelf(senderId, sock)) {
        appendInspectReactionDecisionDiagnostic("ignored", "sender-matches-self", senderId, metadata);
        return;
      }
      displayMode = "inspect";
      if (!inspectState) {
        appendInspectReactionDecisionDiagnostic("handled", "pending-inspect-data", senderId, metadata);
        return;
      }
      const text = formatCurrentInspectText();
      if (!text) {
        appendInspectReactionDecisionDiagnostic("ignored", "empty-inspect-text", senderId, metadata);
        return;
      }
      appendInspectReactionDecisionDiagnostic("handled", "show-inspect", senderId, metadata);
      void showInspectText(text, "reaction.inspect");
    });
  }

  return handle;
}

/**
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} chatId
 * @param {{ quoted?: BaileysMessage } | undefined} options
 * @param {import("../runtime/reaction-runtime.js").ReactionRuntime | undefined} reactionRuntime
 * @param {number} deliveredLines
 * @param {number} totalLines
 * @param {() => Promise<void>} onContinue
 * @returns {Promise<void>}
 */
async function requestSnapshotDiffContinuation(sock, chatId, options, reactionRuntime, deliveredLines, totalLines, onContinue) {
  const remainingLines = Math.max(totalLines - deliveredLines, 0);
  const sent = await sendObservedWhatsAppMessage(
    sock,
    chatId,
    makeTextMessage(`🔧 ⚠️ Snapshot diff rendered ${deliveredLines} of ${totalLines} lines. Continue rendering the remaining ${remainingLines}? React 👍 to continue or 👎 to stop.`),
    options,
  );
  subscribeSnapshotDiffContinuationDecision(reactionRuntime, sent?.key, async () => {
    try {
      await onContinue();
    } catch (error) {
      log.error("Snapshot diff continuation failed", {
        chatId,
        deliveredLines,
        totalLines,
        error: formatErrorMessage(error),
      });
      await sendObservedWhatsAppMessage(
        sock,
        chatId,
        makeTextMessage(`🔧 ⚠️ Snapshot diff continuation failed: ${formatErrorMessage(error)}`),
        options,
      ).catch(() => {});
    }
  });
}

/**
 * @param {import("../runtime/reaction-runtime.js").ReactionRuntime | undefined} reactionRuntime
 * @param {import('@whiskeysockets/baileys').WAMessageKey | undefined} promptKey
 * @param {() => Promise<void>} onContinue
 * @returns {void}
 */
function subscribeSnapshotDiffContinuationDecision(reactionRuntime, promptKey, onContinue) {
  const promptKeyId = promptKey?.id;
  if (!reactionRuntime || typeof promptKeyId !== "string") {
    return;
  }

  let settled = false;
  const timer = setTimeout(() => {
    settled = true;
    unsubscribe();
  }, SNAPSHOT_DIFF_CONTINUATION_TIMEOUT_MS);
  timer.unref?.();

  const unsubscribe = reactionRuntime.subscribe(promptKeyId, (emoji) => {
    if (settled) {
      return;
    }
    if (emoji.startsWith("👎") || emoji.startsWith("❌")) {
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      return;
    }
    if (!emoji.startsWith("👍") && !emoji.startsWith("✅")) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    unsubscribe();
    void onContinue();
  });
}
