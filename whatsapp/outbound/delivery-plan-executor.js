import { generateMessageIDV2, generateWAMessage, generateWAMessageFromContent, proto } from "@whiskeysockets/baileys";
import { randomBytes } from "node:crypto";
import { createLogger } from "../../logger.js";
import { sendImageHD } from "../../whatsapp-hd-media.js";
import { makeImageMessage, makeTextMessage } from "../message-payloads.js";
import {
  buildWhatsAppInstructionDeliveryPlan,
  prependWhatsAppSourcePrefix,
} from "./delivery-plan.js";
import {
  appendWhatsAppOutboundDiagnostic,
  formatWhatsAppDeliveryErrorMessage,
} from "./delivery-diagnostics.js";

const log = createLogger("whatsapp:outbound");
const DEFAULT_ALBUM_RELAY_DELAY_MS = 500;
const DEFAULT_CONTINUATION_TIMEOUT_MS = 30 * 60 * 1000;
const TURN_STATUS_PIN_SECONDS = 60 * 60;

/**
 * @typedef {{
 *   lastEditableKey?: import('@whiskeysockets/baileys').WAMessageKey;
 *   lastEditableMessageKind?: "text" | "image";
 * }} WhatsAppDeliveryExecutionResult
 *
 * @typedef {{
 *   reactionRuntime?: import("../runtime/reaction-runtime.js").ReactionRuntime;
 *   sourcePrefix?: string;
 *   albumRelayDelayMs?: number;
 *   continuationTimeoutMs?: number;
 * }} WhatsAppDeliveryExecutionOptions
 */

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
async function wait(ms) {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} chatId
 * @param {any} msg
 * @param {Record<string, unknown> | undefined} options
 * @returns {Promise<import('@whiskeysockets/baileys').WAMessage | undefined>}
 */
export async function sendObservedWhatsAppMessage(sock, chatId, msg, options) {
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
      error: formatWhatsAppDeliveryErrorMessage(error),
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
export async function relayObservedWhatsAppMessage(sock, chatId, msg, options) {
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
      error: formatWhatsAppDeliveryErrorMessage(error),
    });
    throw error;
  }
}

/**
 * @param {import("../../message-renderer.js").AttachmentDebugInfo | undefined} debug
 * @returns {Record<string, unknown>}
 */
function attachmentDebugFields(debug) {
  return debug ?? {};
}

/**
 * @param {import("./delivery-plan.js").WhatsAppDeliveryStep} step
 * @param {string} chatId
 * @returns {Record<string, unknown>}
 */
function summarizeAttachmentStep(step, chatId) {
  const summary = {
    chatId,
    kind: step.kind,
  };

  switch (step.kind) {
    case "send_image":
      return {
        ...summary,
        bytes: step.image.byteLength,
        ...(step.caption ? { caption: step.caption } : {}),
        ...attachmentDebugFields(step.debug),
      };
    case "send_album":
      return {
        ...summary,
        imageCount: step.items.length,
      };
    case "send_video":
      return {
        ...summary,
        bytes: step.video.byteLength,
        mimetype: step.mimetype,
        ...(step.caption ? { caption: step.caption } : {}),
        ...attachmentDebugFields(step.debug),
      };
    case "send_audio":
      return {
        ...summary,
        bytes: step.audio.byteLength,
        mimetype: step.mimetype,
        ...attachmentDebugFields(step.debug),
      };
    case "send_file":
      return {
        ...summary,
        bytes: step.file.byteLength,
        mimetype: step.mimetype,
        fileName: step.fileName,
        ...(step.caption ? { caption: step.caption } : {}),
        ...attachmentDebugFields(step.debug),
      };
    default:
      return summary;
  }
}

/**
 * @param {import("./delivery-plan.js").WhatsAppDeliveryStep} step
 * @returns {boolean}
 */
function isAttachmentStep(step) {
  return step.kind === "send_image"
    || step.kind === "send_album"
    || step.kind === "send_video"
    || step.kind === "send_audio"
    || step.kind === "send_file";
}

/**
 * Send multiple images as a WhatsApp album using raw protocol messages.
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} chatId
 * @param {Array<{ image: Buffer, caption?: string }>} items
 * @param {{ quoted?: BaileysMessage }} [options]
 * @param {{ albumRelayDelayMs?: number }} [executionOptions]
 * @returns {Promise<import('@whiskeysockets/baileys').WAMessageKey | undefined>}
 */
export async function sendAlbum(sock, chatId, items, options, executionOptions = {}) {
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
  const delayMs = executionOptions.albumRelayDelayMs ?? DEFAULT_ALBUM_RELAY_DELAY_MS;

  for (let index = 0; index < uploaded.length; index += 1) {
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
      await wait(delayMs);
    }
  }

  return firstMediaKey;
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
 * @param {import("./delivery-plan.js").WhatsAppDeliveryMessageKey | undefined} key
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
 * @param {import("./delivery-plan.js").WhatsAppDeliveryMessageKey | undefined} key
 * @param {string} chatId
 * @returns {{ id: string, remoteJid: string } | null}
 */
function resolveReactionMessageKey(key, chatId) {
  if (!key?.id) {
    return null;
  }
  return {
    id: key.id,
    remoteJid: typeof key.remoteJid === "string" ? key.remoteJid : chatId,
  };
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
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} chatId
 * @param {import("./delivery-plan.js").WhatsAppSendTextStep} step
 * @param {{ quoted?: BaileysMessage } | undefined} options
 * @param {WhatsAppDeliveryExecutionOptions} executionOptions
 * @returns {Promise<import('@whiskeysockets/baileys').WAMessage | undefined>}
 */
async function executeTextStep(sock, chatId, step, options, executionOptions) {
  const sent = await sendObservedWhatsAppMessage(sock, chatId, makeTextMessage(step.text), options);
  if (step.continuation && sent?.key) {
    subscribeRenderedImagesContinuation(sock, chatId, step.continuation, sent.key, options, executionOptions);
  }
  return sent;
}

/**
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} chatId
 * @param {import("./delivery-plan.js").WhatsAppSendImageStep} step
 * @param {{ quoted?: BaileysMessage } | undefined} options
 * @returns {Promise<import('@whiskeysockets/baileys').WAMessage | undefined>}
 */
async function executeImageStep(sock, chatId, step, options) {
  if (!step.hd) {
    return sendObservedWhatsAppMessage(sock, chatId, makeImageMessage(step.image, step.caption), options);
  }

  const imageMessage = makeImageMessage(step.image, step.caption);
  appendWhatsAppOutboundDiagnostic({
    transport: "sendMessage",
    phase: "attempt",
    chatId,
    message: imageMessage,
    options,
  });
  try {
    const sent = await sendImageHD(sock, chatId, step.image, step.caption, options);
    appendWhatsAppOutboundDiagnostic({
      transport: "sendMessage",
      phase: "sent",
      chatId,
      message: imageMessage,
      resultKey: sent?.key ?? null,
      options,
    });
    return sent;
  } catch (error) {
    appendWhatsAppOutboundDiagnostic({
      transport: "sendMessage",
      phase: "failed",
      chatId,
      message: imageMessage,
      options,
      error: formatWhatsAppDeliveryErrorMessage(error),
    });
    throw error;
  }
}

/**
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} chatId
 * @param {import("./delivery-plan.js").WhatsAppDeliveryStep} step
 * @param {{ quoted?: BaileysMessage } | undefined} options
 * @param {WhatsAppDeliveryExecutionOptions} executionOptions
 * @returns {Promise<import('@whiskeysockets/baileys').WAMessageKey | undefined>}
 */
async function executeDeliveryStep(sock, chatId, step, options, executionOptions) {
  /** @type {import('@whiskeysockets/baileys').WAMessage | undefined} */
  let sent;
  switch (step.kind) {
    case "send_text":
      sent = await executeTextStep(sock, chatId, step, options, executionOptions);
      return sent?.key;
    case "send_image":
      sent = await executeImageStep(sock, chatId, step, options);
      return sent?.key;
    case "send_album":
      return sendAlbum(sock, chatId, step.items, options, executionOptions);
    case "send_video":
      sent = await sendObservedWhatsAppMessage(sock, chatId, {
        video: step.video,
        mimetype: step.mimetype,
        jpegThumbnail: "",
        ...(step.caption && { caption: step.caption }),
      }, options);
      return sent?.key;
    case "send_audio":
      sent = await sendObservedWhatsAppMessage(sock, chatId, {
        audio: step.audio,
        mimetype: step.mimetype,
      }, options);
      return sent?.key;
    case "send_file":
      sent = await sendObservedWhatsAppMessage(sock, chatId, {
        document: step.file,
        mimetype: step.mimetype,
        fileName: step.fileName,
        ...(step.caption && { caption: step.caption }),
      }, options);
      return sent?.key;
    case "edit_text":
      await editWhatsAppMessage(sock, chatId, step.text, step.target);
      return undefined;
    case "send_reaction": {
      const key = resolveReactionMessageKey(step.target, chatId);
      if (!key) {
        return undefined;
      }
      sent = await sendObservedWhatsAppMessage(sock, chatId, {
        react: { text: step.text, key },
      }, undefined);
      return sent?.key;
    }
    case "pin_message": {
      const key = resolveOutgoingMessageKey(step.target, chatId);
      if (!key) {
        return undefined;
      }
      sent = await sendObservedWhatsAppMessage(sock, chatId, {
        pin: key,
        type: proto.PinInChat.Type.PIN_FOR_ALL,
        time: TURN_STATUS_PIN_SECONDS,
      }, undefined);
      return sent?.key;
    }
    case "unpin_message": {
      const key = resolveOutgoingMessageKey(step.target, chatId);
      if (!key) {
        return undefined;
      }
      sent = await sendObservedWhatsAppMessage(sock, chatId, {
        pin: key,
        type: proto.PinInChat.Type.UNPIN_FOR_ALL,
      }, undefined);
      return sent?.key;
    }
  }
}

/**
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} chatId
 * @param {import("../../message-renderer.js").RenderedImagesContinuation} continuation
 * @param {import('@whiskeysockets/baileys').WAMessageKey} promptKey
 * @param {{ quoted?: BaileysMessage } | undefined} options
 * @param {WhatsAppDeliveryExecutionOptions} executionOptions
 * @returns {void}
 */
function subscribeRenderedImagesContinuation(sock, chatId, continuation, promptKey, options, executionOptions) {
  const promptKeyId = promptKey.id;
  const reactionRuntime = executionOptions.reactionRuntime;
  if (!reactionRuntime || typeof promptKeyId !== "string") {
    return;
  }

  let settled = false;
  const timer = setTimeout(() => {
    settled = true;
    unsubscribe();
  }, executionOptions.continuationTimeoutMs ?? DEFAULT_CONTINUATION_TIMEOUT_MS);
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
    void sendRenderedImagesContinuation(sock, chatId, continuation, options, executionOptions).catch((error) => {
      const sourcePrefix = executionOptions.sourcePrefix ?? "";
      log.error("Rendered image continuation failed", {
        chatId,
        label: continuation.label,
        totalImages: continuation.totalImages,
        error: formatWhatsAppDeliveryErrorMessage(error),
      });
      void sendObservedWhatsAppMessage(
        sock,
        chatId,
        makeTextMessage(prependWhatsAppSourcePrefix(
          sourcePrefix,
          `⚠️ ${continuation.label} continuation failed: ${formatWhatsAppDeliveryErrorMessage(error)}`,
        )),
        options,
      ).catch(() => {});
    });
  });
}

/**
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} chatId
 * @param {import("../../message-renderer.js").RenderedImagesContinuation} continuation
 * @param {{ quoted?: BaileysMessage } | undefined} options
 * @param {WhatsAppDeliveryExecutionOptions} executionOptions
 * @returns {Promise<void>}
 */
async function sendRenderedImagesContinuation(sock, chatId, continuation, options, executionOptions) {
  const imageInstructions = await continuation.renderAll();
  if (imageInstructions.length === 0) {
    return;
  }
  const continuationPlan = buildWhatsAppInstructionDeliveryPlan({
    instructions: imageInstructions,
    sourcePrefix: executionOptions.sourcePrefix ?? "",
  });
  await executeWhatsAppDeliveryPlan(sock, chatId, continuationPlan, options, executionOptions);
}

/**
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} chatId
 * @param {import("./delivery-plan.js").WhatsAppDeliveryPlan} plan
 * @param {{ quoted?: BaileysMessage } | undefined} [options]
 * @param {WhatsAppDeliveryExecutionOptions} [executionOptions]
 * @returns {Promise<WhatsAppDeliveryExecutionResult>}
 */
export async function executeWhatsAppDeliveryPlan(sock, chatId, plan, options, executionOptions = {}) {
  /** @type {WhatsAppDeliveryExecutionResult} */
  const result = {};

  for (const step of plan.steps) {
    if (isAttachmentStep(step)) {
      log.info("Sending attachment instruction", summarizeAttachmentStep(step, chatId));
    }

    try {
      const sentKey = await executeDeliveryStep(sock, chatId, step, options, executionOptions);
      if (step.id === plan.editableStepId && sentKey) {
        result.lastEditableKey = sentKey;
        result.lastEditableMessageKind = plan.editableMessageKind;
      }
      if (isAttachmentStep(step)) {
        log.info("Sent attachment instruction", {
          ...summarizeAttachmentStep(step, chatId),
          messageId: sentKey?.id,
        });
      }
    } catch (error) {
      if (isAttachmentStep(step)) {
        log.error("Attachment instruction send failed", {
          ...summarizeAttachmentStep(step, chatId),
          error: formatWhatsAppDeliveryErrorMessage(error),
        });
      }
      throw error;
    }
  }

  return result;
}
