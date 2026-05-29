import { generateMessageIDV2, generateWAMessage, generateWAMessageFromContent, proto } from "@whiskeysockets/baileys";
import { randomBytes } from "node:crypto";
import { createLogger } from "../../logger.js";
import { renderBlocks } from "../../message-renderer.js";
import { formatPlanPresentationText } from "../../plan-presentation.js";
import { formatToolFlowInspectText, formatToolFlowSummary } from "../../tool-flow-presentation.js";
import { formatActivitySummary, shortenPath } from "../../tool-presentation-model.js";
import { formatUsageEventText } from "../../usage-formatting.js";
import { isIgnoredRuntimeStateFileChange } from "../../whatsapp-outbound-event-policy.js";
import {
  formatToolPresentationDisplay,
  formatToolPresentationInspect,
  formatToolPresentationSummary,
  langFromPath,
} from "../../presentation/whatsapp.js";
import { sendImageHD } from "../../whatsapp-hd-media.js";

/** Delay between relaying each image in an album so WhatsApp groups them. */
const ALBUM_RELAY_DELAY_MS = 500;
const WHATSAPP_EDIT_HANDLE_TTL_MS = 14 * 60 * 1000;
const log = createLogger("whatsapp:outbound");
/** @type {Map<string, WhatsAppEditHandleRecord>} */
const inMemoryEditHandles = new Map();
/** @type {Map<string, { handle?: MessageHandle, entries: Array<{ icon: string, provider: string, summary: string, detail?: string }> }>} */
const runtimeStatusByChat = new Map();

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
  if (displayKind === "add") {
    return "*Add File*";
  }
  if (displayKind === "delete") {
    return "*Delete File*";
  }
  return "*Update File*";
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
  const captionLines = [`${title}  \`${displayPath}\``];
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

  return cleanedSummary ? `${captionLines.join("\n")}` : `${title}  \`${displayPath}\``;
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
      const content = formatToolPresentationDisplay(event.presentation) ?? formatToolPresentationSummary(event.presentation);
      return { source: "tool-call", content };
    }
    case "tool_activity":
      return { source: "tool-call", content: formatActivitySummary(event.activity) };
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
    const sent = await sock.sendMessage(chatId, {
      image: items[0].image,
      ...(items[0].caption && { caption: items[0].caption }),
    }, options ?? {});
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
      {
        image: item.image,
        ...(item.caption && { caption: item.caption }),
      },
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

  await sock.sendMessage(jid, { text: newText, edit: resolved.key });
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
  if (isIgnoredRuntimeStateFileChange(event)) {
    return undefined;
  }
  if (event.kind === "runtime_event") {
    return sendRuntimeEvent(sock, chatId, event, options, reactionRuntime, sendOptions);
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
          sent = await sock.sendMessage(chatId, { text: instruction.text }, options);
          if (instruction.editable && sent?.key) {
            lastSentKey = sent.key;
            lastSentIsImage = false;
          }
          break;
        case "image":
          if (instruction.hd) {
            sent = await sendImageHD(sock, chatId, instruction.image, instruction.caption, options);
          } else {
            sent = await sock.sendMessage(chatId, {
              image: instruction.image,
              ...(instruction.caption && { caption: instruction.caption }),
            }, options);
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
