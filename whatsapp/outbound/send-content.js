import { randomBytes } from "node:crypto";
import { createLogger } from "../../logger.js";
import { formatToolFlowInspectText, formatToolFlowSummary } from "../tool-flow-presenter.js";
import { buildToolPresentation, shortenPath } from "../tool-presentation-model.js";
import {
  formatToolPresentationInspect,
  formatToolPresentationSummary,
} from "../tool-presenter.js";
import {
  buildSnapshotFileChangeDiffText,
  countDiffLines,
  renderFileChangeContent,
  splitSnapshotDiffText,
} from "./file-change-content.js";
import {
  buildToolPresentationFromToolCallEvent,
  renderAgentToolResultEvent,
  renderAppMessageEvent,
  renderAssistantOutputEvent,
  renderPlanEvent,
  renderSubagentMessageEvent,
  renderToolActivityEvent,
  renderToolCallEvent,
  renderUsageEvent,
} from "./event-rendering.js";
import {
  buildWhatsAppContentDeliveryPlan,
  buildWhatsAppPinDeliveryPlan,
  buildWhatsAppReactionDeliveryPlan,
  buildWhatsAppTextDeliveryPlan,
  getWhatsAppSourcePrefix,
  prependWhatsAppSourcePrefix,
} from "./delivery-plan.js";
import {
  editWhatsAppMessage as executeWhatsAppMessageEdit,
  executeWhatsAppDeliveryPlan,
  sendAlbum,
} from "./delivery-plan-executor.js";
import {
  appendWhatsAppOutboundDiagnostic,
  formatWhatsAppDeliveryErrorMessage,
} from "./delivery-diagnostics.js";
export { renderFileChangeContent } from "./file-change-content.js";
export {
  appendWhatsAppOutboundDiagnostic,
  sendAlbum,
};
export { executeWhatsAppMessageEdit as editWhatsAppMessage };

/** Delay between relaying each image in an album so WhatsApp groups them. */
const ALBUM_RELAY_DELAY_MS = 500;
const SNAPSHOT_DIFF_CONTINUATION_TIMEOUT_MS = 30 * 60 * 1000;
const WHATSAPP_EDIT_HANDLE_TTL_MS = 14 * 60 * 1000;
const DEFAULT_WHATSAPP_EDIT_DEBOUNCE_MS = 1000;
const INSPECT_REACTION_EMOJI = "👁";
const log = createLogger("whatsapp:outbound");
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

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
 * @param {Extract<RuntimeEventOutboundEvent["event"], { tool: unknown }>["tool"]} tool
 * @returns {{ start: number, end: number } | null}
 */
function getRuntimeToolReadLineRange(tool) {
  const line = typeof tool.arguments.line === "number"
    ? tool.arguments.line
    : typeof tool.arguments.offset === "number" ? tool.arguments.offset : undefined;
  const limit = typeof tool.arguments.limit === "number" ? tool.arguments.limit : undefined;
  return lineLimitToRange(line, limit);
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
  if (!key?.id) {
    observePinnedStatusDelivery(observer, { type: "pin.skipped", chatId });
    return;
  }
  const messageId = getMessageKeyId(key);
  try {
    await executeWhatsAppDeliveryPlan(sock, chatId, buildWhatsAppPinDeliveryPlan({
      action: "pin",
      target: key,
    }));
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
      messageId: key.id,
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
  if (!key?.id) {
    observePinnedStatusDelivery(observer, { type: "unpin.skipped", chatId });
    return;
  }
  const messageId = getMessageKeyId(key);
  try {
    await executeWhatsAppDeliveryPlan(sock, chatId, buildWhatsAppPinDeliveryPlan({
      action: "unpin",
      target: key,
    }));
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
      messageId: key.id,
      error: formatErrorMessage(error),
    });
  }
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
  if (event.kind !== "assistant_output") {
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
 * @param {string} chatId
 * @param {"👍" | "👎"} emoji
 * @returns {Promise<boolean>}
 */
async function prefixLatestToolMessage(chatId, emoji) {
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
  const detailSummary = formatRuntimeToolDetailSummary(tool, cwd);
  if (detailSummary.handled) {
    return detailSummary.summary;
  }
  return formatGenericToolSummary(tool.name, tool.arguments, cwd);
}

/**
 * @param {Extract<RuntimeEventOutboundEvent["event"], { tool: unknown }>["tool"]} tool
 * @param {string | null | undefined} cwd
 * @returns {{ handled: true, summary: string | null } | { handled: false }}
 */
function formatRuntimeToolDetailSummary(tool, cwd) {
  const displayName = tool.name.trim() || "Tool";
  if (displayName === "Shell") {
    const command = getStringArg(tool.arguments, ["command"]);
    if (command) {
      return { handled: true, summary: formatRuntimeCommandSummary(command) };
    }
  }
  if (displayName === "stdin" || displayName === "write_stdin") {
    return { handled: true, summary: null };
  }
  const pathDetail = getStringArg(tool.arguments, ["path", "file_path", "filePath"]);
  if (pathDetail) {
    return {
      handled: true,
      summary: formatRuntimeProgressEntry(displayName, `\`${shortenPath(pathDetail, cwd ?? null)}\``),
    };
  }
  const textDetail = getStringArg(tool.arguments, ["description", "title", "message", "prompt", "query", "q"]);
  if (textDetail) {
    return { handled: true, summary: formatRuntimeProgressEntry(displayName, textDetail) };
  }
  return { handled: false };
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
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {string | null | undefined} cwd
 * @returns {string | null}
 */
function formatGenericToolSummary(name, args, cwd) {
  const presentation = buildToolPresentation(name, args, undefined, cwd ?? null, undefined);
  if (presentation?.kind !== "generic") {
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
  const displayTool = toolEvent.tool;

  const status = toolEvent.type.split(".")[1];
  if (status !== "started" && status !== "updated" && status !== "completed" && status !== "failed") {
    return undefined;
  }
  const summary = formatRuntimeToolSummary(displayTool, event.cwd);
  const readRange = getRuntimeToolReadLineRange(displayTool);
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
    const displayTool = runtimeEvent.tool;
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
      summary: appendReadLineRange(summaryBase, getRuntimeToolReadLineRange(displayTool)),
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
    case "assistant_output": {
      if (!Array.isArray(event.content)) {
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
 * @param {unknown} error
 * @returns {string}
 */
function formatErrorMessage(error) {
  return formatWhatsAppDeliveryErrorMessage(error);
}

/**
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} chatId
 * @param {string} text
 * @param {{ quoted?: BaileysMessage } | undefined} options
 * @param {{ returnKey?: boolean }} [planOptions]
 * @returns {Promise<import('@whiskeysockets/baileys').WAMessageKey | undefined>}
 */
async function sendTextDeliveryPlan(sock, chatId, text, options, planOptions = {}) {
  const returnKey = planOptions.returnKey === true;
  const result = await executeWhatsAppDeliveryPlan(sock, chatId, buildWhatsAppTextDeliveryPlan({
    text,
    editable: returnKey,
  }), options);
  return result.lastEditableKey;
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
 * @param {OutboundEvent} event
 * @returns {{ source: MessageSource, content: SendContent, cwd?: string | null } | null}
 */
function renderOutboundEvent(event) {
  switch (event.kind) {
    case "app_message":
      return renderAppMessageEvent(event);
    case "assistant_output":
      return renderAssistantOutputEvent(event);
    case "agent_tool_result":
      return renderAgentToolResultEvent(event);
    case "tool_call":
      return renderToolCallEvent(event);
    case "tool_activity":
      return renderToolActivityEvent(event);
    case "plan":
      return renderPlanEvent(event);
    case "file_change":
      return { source: "tool-call", content: renderFileChangeContent(event) };
    case "usage":
      return renderUsageEvent(event);
    case "subagent_message":
      return renderSubagentMessageEvent(event);
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
  await executeWhatsAppMessageEdit(sock, record.chatId, newText, {
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
  const prefix = getWhatsAppSourcePrefix(source);
  const plan = await buildWhatsAppContentDeliveryPlan({
    source,
    content,
    renderOptions,
  });
  const execution = await executeWhatsAppDeliveryPlan(sock, chatId, plan, options, {
    reactionRuntime,
    sourcePrefix: prefix,
    albumRelayDelayMs: ALBUM_RELAY_DELAY_MS,
    continuationTimeoutMs: SNAPSHOT_DIFF_CONTINUATION_TIMEOUT_MS,
  });
  if (!execution.lastEditableKey) return undefined;

  const editKey = execution.lastEditableKey;
  const isImage = execution.lastEditableMessageKind === "image";
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
    void executeWhatsAppDeliveryPlan(sock, chatId, buildWhatsAppReactionDeliveryPlan({
      text: INSPECT_REACTION_EMOJI,
      target: editKey,
    })).catch((error) => {
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
      const text = inspectText ?? prependWhatsAppSourcePrefix(prefix, summarizeHandleUpdate(update));
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
      return prependWhatsAppSourcePrefix(prefix, formatInspectEditText("", inspectState.text));
    }
    const inspect = formatInspectState(inspectState);
    return prependWhatsAppSourcePrefix(prefix, formatInspectEditText(inspect.summary, inspect.text));
  }

  /**
   * @param {string} text
   * @param {"reaction.inspect" | "handle.setInspect"} cause
   * @returns {Promise<void>}
   */
  async function showInspectText(text, cause) {
    const attempt = ++inspectRenderAttempt;
    if (isExpiredWhatsAppEditHandle(editHandle)) {
      await sendTextDeliveryPlan(sock, chatId, text, undefined);
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
      await sendTextDeliveryPlan(sock, chatId, text, undefined);
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
  const promptKey = await sendTextDeliveryPlan(
    sock,
    chatId,
    `🔧 ⚠️ Snapshot diff rendered ${deliveredLines} of ${totalLines} lines. Continue rendering the remaining ${remainingLines}? React 👍 to continue or 👎 to stop.`,
    options,
    { returnKey: true },
  );
  subscribeSnapshotDiffContinuationDecision(reactionRuntime, promptKey, async () => {
    try {
      await onContinue();
    } catch (error) {
      log.error("Snapshot diff continuation failed", {
        chatId,
        deliveredLines,
        totalLines,
        error: formatErrorMessage(error),
      });
      await sendTextDeliveryPlan(
        sock,
        chatId,
        `🔧 ⚠️ Snapshot diff continuation failed: ${formatErrorMessage(error)}`,
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
