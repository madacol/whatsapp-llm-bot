import { generateMessageIDV2, generateWAMessage, generateWAMessageFromContent, proto } from "@whiskeysockets/baileys";
import { randomBytes } from "node:crypto";
import { createLogger } from "../../logger.js";
import { renderBlocks } from "../../message-renderer.js";
import { formatPlanPresentationText } from "../../plan-presentation.js";
import { formatToolFlowInspectText, formatToolFlowSummary } from "../tool-flow-presenter.js";
import { shortenPath } from "../../tool-presentation-model.js";
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
const WHATSAPP_EDIT_HANDLE_TTL_MS = 14 * 60 * 1000;
const log = createLogger("whatsapp:outbound");
/** @type {Map<string, WhatsAppEditHandleRecord>} */
const inMemoryEditHandles = new Map();
/** @type {Map<string, { handle?: MessageHandle, entries: Array<{ icon: string, provider: string, summary: string, detail?: string }> }>} */
const runtimeStatusByChat = new Map();
/** @type {Map<string, Map<string, { handle?: MessageHandle, command: string }>>} */
const runtimeCommandsByChat = new Map();
/** @type {Map<string, Map<string, { handle?: MessageHandle, summary: string }>>} */
const runtimeToolsByChat = new Map();
/** @type {Map<string, {
 *   handle?: MessageHandle,
 *   entries: Array<{ id: string, summary: string, inspectDetail?: string, completed: boolean, failed: boolean }>,
 *   pendingCommandEntryIds: Map<string, string[]>,
 *   pendingToolEntryIds: string[],
 *   pendingToolEntryIdsByToolId: Map<string, string>,
 *   debounceTimer: ReturnType<typeof setTimeout> | null,
 *   nextEntryId: number,
 * }>} */
const compactToolActivityByChat = new Map();

const COMPACT_TOOL_ACTIVITY_LIMIT = 3;
const COMPACT_TOOL_ACTIVITY_DEBOUNCE_MS = 1000;

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
 * @param {string[]} paths
 * @returns {string}
 */
function formatRuntimeFileReadSummary(paths) {
  const displayPaths = paths
    .filter((filePath) => typeof filePath === "string" && filePath.length > 0)
    .map((filePath) => `\`${filePath}\``);
  return formatRuntimeProgressEntry("Read", displayPaths.length > 0 ? displayPaths.join(", ") : undefined);
}

/**
 * @param {Extract<RuntimeEventOutboundEvent["event"], { tool: unknown }>["tool"]} tool
 * @returns {boolean}
 */
function isNoopRuntimeTool(tool) {
  return tool.name === "Editing files" && Object.keys(tool.arguments).length === 0;
}

/**
 * @param {Extract<RuntimeEventOutboundEvent["event"], { tool: unknown }>["tool"]} tool
 * @returns {string}
 */
function formatRuntimeToolSummary(tool) {
  const displayName = tool.name.trim() || "Tool";
  const pathDetail = getStringArg(tool.arguments, ["path", "file_path", "filePath"]);
  if (pathDetail) {
    return formatRuntimeProgressEntry(displayName, `\`${pathDetail}\``);
  }
  const textDetail = getStringArg(tool.arguments, ["title", "message", "prompt", "query", "q"]);
  return formatRuntimeProgressEntry(displayName, textDetail);
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
 * @param {string} value
 * @returns {string}
 */
function boldTarget(value) {
  return `*${value.trim()}*`;
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
 * @returns {string}
 */
function formatCompactRead(paths) {
  const displayPaths = paths
    .filter((filePath) => typeof filePath === "string" && filePath.length > 0)
    .map((filePath) => `\`${filePath}\``);
  return formatCompactEntry("Read", displayPaths.length > 0 ? displayPaths.join(", ") : undefined);
}

/**
 * @param {string} toolName
 * @returns {string | null}
 */
function formatGenericSearchToolName(toolName) {
  const match = toolName.match(/^Search for '(.+)' in (.+)$/);
  if (!match) {
    return null;
  }
  const [, pattern, target] = match;
  if (!pattern || !target) {
    return null;
  }
  return formatCompactEntry("Search", `\`${pattern}\` in ${boldTarget(target)}`);
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
 * @param {string} toolName
 * @param {Record<string, unknown>} args
 * @param {string | null | undefined} cwd
 * @returns {string}
 */
function formatGenericCompactToolName(toolName, args, cwd) {
  const search = formatGenericSearchToolName(toolName);
  if (search) {
    return search;
  }
  const pathDetail = formatGenericPathDetail(args, cwd);
  const displayToolName = stripSimpleMarkdown(toolName).toLowerCase() === "read file"
    ? "Read"
    : toolName;
  return formatCompactEntry(displayToolName, pathDetail);
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
    return formatCompactRead(activity.paths);
  }
  if (activity.type !== "tool" || !activity.toolCall) {
    return null;
  }
  const presentation = activity.presentation;
  const args = parseCompactToolArguments(activity.toolCall.arguments);
  if (!presentation) {
    return formatGenericCompactToolName(activity.toolCall.name, args, cwd);
  }
  switch (presentation.kind) {
    case "activity":
      return formatCompactEntry(
        presentation.activity.title,
        presentation.activity.lines.length > 0 ? presentation.activity.lines.join(", ") : undefined,
      );
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
 * @param {{ editHandleStore?: import("../../store.js").Store }} sendOptions
 * @returns {Promise<MessageHandle | undefined>}
 */
async function sendRuntimeFileChangeEvent(sock, chatId, event, options, reactionRuntime, sendOptions) {
  const fileChange = fileChangeEventFromRuntimeEvent(event.event);
  return sendBlocks(sock, chatId, "tool-call", renderFileChangeContent(fileChange), options, reactionRuntime, event, {
    workdir: fileChange.cwd ?? null,
    editHandleStore: sendOptions.editHandleStore,
  });
}

/**
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} chatId
 * @param {RuntimeEventOutboundEvent} event
 * @param {{ quoted?: BaileysMessage } | undefined} options
 * @param {import("../runtime/reaction-runtime.js").ReactionRuntime | undefined} reactionRuntime
 * @param {{ editHandleStore?: import("../../store.js").Store }} sendOptions
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
  const text = `${getRuntimeCommandIcon(status)} ${summary}`;

  if (status === "started") {
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
  if (!state?.handle) {
    if (status === "failed") {
      const detail = commandEvent.command.output ? `\n\n${commandEvent.command.output}` : "";
      return sendBlocks(sock, chatId, "error", `Command failed: \`${command}\`${detail}`, options, reactionRuntime, event, {
        editHandleStore: sendOptions.editHandleStore,
      });
    }
    return undefined;
  }

  state.handle.setInspect({
    kind: "text",
    text: commandEvent.command.output ?? "_no output_",
    persistOnInspect: true,
  });
  await state.handle.update({ kind: "text", text });
  commandStateByCommand?.delete(command);
  if (!commandStateByCommand || commandStateByCommand.size === 0) {
    runtimeCommandsByChat.delete(chatId);
  }
  return state.handle;
}

/**
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} chatId
 * @param {RuntimeEventOutboundEvent} event
 * @param {{ quoted?: BaileysMessage } | undefined} options
 * @param {import("../runtime/reaction-runtime.js").ReactionRuntime | undefined} reactionRuntime
 * @param {{ editHandleStore?: import("../../store.js").Store }} sendOptions
 * @returns {Promise<MessageHandle | undefined>}
 */
async function sendRuntimeFileReadEvent(sock, chatId, event, options, reactionRuntime, sendOptions) {
  if (event.event.type !== "file-read.started") {
    throw new Error(`Expected file-read runtime event, got ${event.event.type}.`);
  }
  return sendBlocks(sock, chatId, "plain", `🔧 ${formatRuntimeFileReadSummary(event.event.fileRead.paths)}`, options, reactionRuntime, event, {
    editHandleStore: sendOptions.editHandleStore,
  });
}

/**
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} chatId
 * @param {RuntimeEventOutboundEvent} event
 * @param {{ quoted?: BaileysMessage } | undefined} options
 * @param {import("../runtime/reaction-runtime.js").ReactionRuntime | undefined} reactionRuntime
 * @param {{ editHandleStore?: import("../../store.js").Store }} sendOptions
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

  const status = toolEvent.type.split(".")[1];
  if (status !== "started" && status !== "updated" && status !== "completed" && status !== "failed") {
    return undefined;
  }
  const summary = formatRuntimeToolSummary(toolEvent.tool);
  const text = `${getRuntimeToolIcon(status)} ${summary}`;

  if (status === "started") {
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
  if (state?.handle) {
    if (toolEvent.tool.output !== undefined) {
      state.handle.setInspect({
        kind: "text",
        text: toolEvent.tool.output,
        persistOnInspect: true,
      });
    }
    if (status !== "updated") {
      await state.handle.update({ kind: "text", text });
      toolStateById?.delete(toolEvent.tool.id);
      if (!toolStateById || toolStateById.size === 0) {
        runtimeToolsByChat.delete(chatId);
      }
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
 * @param {{ completed: boolean, failed: boolean, summary: string }} entry
 * @returns {string}
 */
function renderCompactToolActivityEntry(entry) {
  const icon = entry.failed ? "❌" : entry.completed ? "✅" : "🔧";
  return `${icon} ${entry.summary}`;
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
    persistOnInspect: true,
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
 * @param {{ editHandleStore?: import("../../store.js").Store }} sendOptions
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
 * @param {{ editHandleStore?: import("../../store.js").Store }} sendOptions
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
      summary: formatCompactRead(activity.paths),
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

  if (activity.type === "tool") {
    let entryId = activity.toolCall?.id ? state.pendingToolEntryIdsByToolId.get(activity.toolCall.id) : undefined;
    if (!entryId && activity.status === "failed") {
      while (state.pendingToolEntryIds.length > 0 && !entryId) {
        entryId = state.pendingToolEntryIds.pop();
      }
    }
    if (entryId && markCompactEntry(state, entryId, activity.status === "failed" ? "failed" : "completed")) {
      forgetCompactPendingToolEntry(state, entryId);
      return flushCompactToolActivity(state);
    }
  }

  return state.handle;
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
  const gap = title.startsWith("*") ? "  " : " ";
  return `${title}${gap}*${displayPath}*`;
}

/**
 * @param {FileChangeEvent} event
 * @returns {"add" | "delete" | "update" | undefined}
 */
function inferDisplayedFileChangeKind(event) {
  const diffKind = inferFileChangeKindFromDiff(event.diff);

  if (event.changeKind === "add" && typeof event.newText === "string") {
    if (typeof event.oldText === "string" && event.oldText.length > 0) {
      return "update";
    }
    return "add";
  }

  if (typeof event.oldText === "string" && typeof event.newText === "string") {
    if (event.oldText !== event.newText) {
      if (event.oldText.length === 0 && event.newText.length > 0 && (event.changeKind === "add" || diffKind === "add")) {
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
      return { source: "tool-call", content: renderToolPresentationContent(event.presentation) };
    }
    case "tool_activity":
      return { source: "tool-call", content: renderToolActivityContent(event.activity) };
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
 * @param {{ editHandleStore?: import("../../store.js").Store }} [sendOptions]
 * @returns {Promise<MessageHandle | undefined>}
 */
async function sendRuntimeEvent(sock, chatId, event, options, reactionRuntime, sendOptions = {}) {
  if (event.event.type === "file-read.started") {
    return sendRuntimeFileReadEvent(sock, chatId, event, options, reactionRuntime, sendOptions);
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
    if (event.event.type === "turn.completed") {
      runtimeStatusByChat.delete(chatId);
    }
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
    persistOnInspect: true,
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
    const sent = await sock.sendMessage(chatId, makeImageMessage(items[0].image, items[0].caption), options ?? {});
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

  await sock.relayMessage(chatId, albumMsg.message, { messageId: albumMsgId });

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

    await sock.relayMessage(chatId, imageMessage.message, {
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
    await sock.relayMessage(jid, {
      protocolMessage: {
        key: resolved.key,
        type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
        editedMessage: { imageMessage: { caption: newText } },
      },
    }, { additionalAttributes: { edit: "1" } });
    return;
  }

  await sock.sendMessage(jid, makeTextMessage(newText, { edit: resolved.key }));
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
 * Dispatch a semantic outbound event as WhatsApp messages.
 * Returns a MessageHandle for the last editable message sent (if any).
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} chatId
 * @param {OutboundEvent} event
 * @param {{ quoted?: BaileysMessage } | undefined} options
 * @param {import("../runtime/reaction-runtime.js").ReactionRuntime | undefined} reactionRuntime
 * @param {{ editHandleStore?: import("../../store.js").Store }} [sendOptions]
 * @returns {Promise<MessageHandle | undefined>}
 */
export async function sendEvent(sock, chatId, event, options, reactionRuntime, sendOptions = {}) {
  if (event.kind === "runtime_event") {
    return sendRuntimeEvent(sock, chatId, event, options, reactionRuntime, sendOptions);
  }
  if (event.kind === "compact_tool_activity") {
    return sendCompactToolActivityEvent(sock, chatId, event, options, reactionRuntime, sendOptions);
  }
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
 * @param {{ workdir?: string | null, editHandleStore?: import("../../store.js").Store }} [renderOptions]
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

    if (instruction.kind !== "text") {
      log.info("Sending attachment instruction", summarizeAttachmentInstruction(instruction, chatId));
    }

    try {
      switch (instruction.kind) {
        case "text":
          sent = await sock.sendMessage(chatId, makeTextMessage(instruction.text), options);
          if (instruction.editable && sent?.key) {
            lastSentKey = sent.key;
            lastSentIsImage = false;
          }
          break;
        case "image":
          if (instruction.hd) {
            sent = await sendImageHD(sock, chatId, instruction.image, instruction.caption, options);
          } else {
            sent = await sock.sendMessage(chatId, makeImageMessage(instruction.image, instruction.caption), options);
          }
          if (instruction.editable && sent?.key) {
            lastSentKey = sent.key;
            lastSentIsImage = true;
          }
          break;
        case "video":
          sent = await sock.sendMessage(chatId, {
            video: instruction.video,
            mimetype: instruction.mimetype,
            jpegThumbnail: "",
            ...(instruction.caption && { caption: instruction.caption }),
          }, options);
          break;
        case "audio":
          sent = await sock.sendMessage(chatId, {
            audio: instruction.audio,
            mimetype: instruction.mimetype,
          }, options);
          break;
        case "file":
          sent = await sock.sendMessage(chatId, {
            document: instruction.file,
            mimetype: instruction.mimetype,
            fileName: instruction.fileName,
            ...(instruction.caption && { caption: instruction.caption }),
          }, options);
          break;
      }
    } catch (error) {
      if (instruction.kind !== "text") {
        log.error("Attachment instruction send failed", {
          ...summarizeAttachmentInstruction(instruction, chatId),
          error: formatErrorMessage(error),
        });
      }
      throw error;
    }

    if (instruction.kind !== "text") {
      log.info("Sent attachment instruction", {
        ...summarizeAttachmentInstruction(instruction, chatId),
        messageId: sent?.key?.id,
      });
    }
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
  const transportHandleId = editHandle.id;
  /** @type {MessageInspectState | null} */
  let inspectState = event?.kind === "tool_call"
    ? { kind: "tool", presentation: event.presentation }
    : null;
  let persistInspectText = false;

  /** @type {MessageHandle} */
  const handle = {
    transportHandleId,
    deliveryStatus: "sent",
    waitUntilSent: async () => handle,
    update: async (update) => {
      const text = persistInspectText && inspectState?.kind === "text" && inspectState.persistOnInspect
        ? formatInspectEditText("", inspectState.text)
        : summarizeHandleUpdate(update);
      await editWhatsAppMessageByHandle(
        sock,
        transportHandleId,
        prependSourcePrefix(prefix, text),
        { store: renderOptions.editHandleStore },
      );
    },
    setInspect: (inspect) => {
      inspectState = inspect;
    },
  };

  if (editKey.id && reactionRuntime) {
    reactionRuntime.subscribe(editKey.id, (emoji) => {
      if (!emoji.startsWith("👁") || !inspectState) {
        return;
      }
      if (inspectState.kind === "text") {
        persistInspectText = inspectState.persistOnInspect === true;
        void editWhatsAppMessage(
          sock,
          chatId,
          prependSourcePrefix(prefix, formatInspectEditText("", inspectState.text)),
          { messageKey: editHandle.messageKey, messageKind: editHandle.messageKind },
        );
        return;
      }
      const inspect = formatInspectState(inspectState);
      void editWhatsAppMessage(
        sock,
        chatId,
        prependSourcePrefix(prefix, formatInspectEditText(inspect.summary, inspect.text)),
        { messageKey: editHandle.messageKey, messageKind: editHandle.messageKind },
      );
    });
  }

  return handle;
}
