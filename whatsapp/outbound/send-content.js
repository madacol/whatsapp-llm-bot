import { generateMessageIDV2, generateWAMessage, generateWAMessageFromContent, proto } from "@whiskeysockets/baileys";
import { randomBytes } from "node:crypto";
import { renderBlocks } from "../../message-renderer.js";
import { formatToolFlowInspectText, formatToolFlowSummary } from "../../tool-flow-presentation.js";
import { formatActivitySummary, shortenPath } from "../../tool-presentation-model.js";
import {
  formatToolPresentationDisplay,
  formatToolPresentationInspect,
  formatToolPresentationSummary,
  langFromPath,
} from "../../presentation/whatsapp.js";
import { sendImageHD } from "../../whatsapp-hd-media.js";

/** Delay between relaying each image in an album so WhatsApp groups them. */
const ALBUM_RELAY_DELAY_MS = 500;

/** @type {Record<MessageSource, string>} */
const SOURCE_PREFIX = {
  llm: "🤖",
  "tool-call": "🔧",
  "tool-result": "✅",
  error: "❌",
  warning: "⚠️",
  usage: "📊",
  memory: "🧠",
};

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
  return `${summary}\n\n${display}`;
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
 * @returns {"add" | "delete" | "update" | undefined}
 */
function inferDisplayedFileChangeKind(event) {
  if (event.changeKind) {
    return event.changeKind;
  }

  const diffKind = inferFileChangeKindFromDiff(event.diff);
  if (diffKind) {
    return diffKind;
  }

  if (typeof event.oldText === "string" && typeof event.newText === "string") {
    if (event.oldText !== event.newText) {
      return "update";
    }
  } else if (typeof event.oldText === "string") {
    return "delete";
  } else if (typeof event.newText === "string") {
    return "add";
  }

  return event.changeKind;
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
 * @param {FileChangeEvent} event
 * @returns {SendContent}
 */
export function renderFileChangeContent(event) {
  const displayPath = shortenPath(event.path, event.cwd ?? null);
  const displayKind = inferDisplayedFileChangeKind(event);
  const cleanedSummary = cleanFileChangeSummary(event.summary, event.path, displayPath, displayKind);

  if (event.diff) {
    const title = displayKind === "add"
      ? "*File added*"
      : displayKind === "delete"
        ? "*File deleted*"
        : "*File changed*";
    const captionLines = [`${title}  \`${displayPath}\``];
    if (cleanedSummary) {
      captionLines.push(cleanedSummary);
    }
    return [{
      type: "diff",
      oldStr: event.oldText ?? "",
      newStr: event.newText ?? "",
      diffText: event.diff,
      language: langFromPath(event.path) || "text",
      caption: captionLines.join("\n"),
    }];
  }

  return cleanedSummary ? `${cleanedSummary}\n\`${displayPath}\`` : `Changed file: \`${displayPath}\``;
}

/**
 * @param {OutboundEvent} event
 * @returns {{ source: MessageSource, content: SendContent } | null}
 */
function renderOutboundEvent(event) {
  switch (event.kind) {
    case "content":
      return { source: event.source, content: event.content };
    case "tool_call": {
      const content = formatToolPresentationDisplay(event.presentation) ?? formatToolPresentationSummary(event.presentation);
      return { source: "tool-call", content };
    }
    case "tool_activity":
      return { source: "tool-call", content: formatActivitySummary(event.activity) };
    case "plan":
      return { source: "llm", content: [{ type: "markdown", text: `*Plan*\n\n${event.text}` }] };
    case "file_change":
      return { source: "tool-call", content: renderFileChangeContent(event) };
    case "usage":
      return {
        source: "usage",
        content: `Cost: ${event.cost} | prompt=${event.tokens.prompt} cached=${event.tokens.cached} completion=${event.tokens.completion}`,
      };
    default:
      return null;
  }
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
 * @param {import('@whiskeysockets/baileys').WAMessageKey} key
 * @param {string} newText
 * @param {boolean} isImage
 * @returns {Promise<void>}
 */
export async function editWhatsAppMessage(sock, jid, key, newText, isImage) {
  if (isImage) {
    await sock.relayMessage(jid, {
      protocolMessage: {
        key,
        type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
        editedMessage: { imageMessage: { caption: newText } },
      },
    }, { additionalAttributes: { edit: "1" } });
    return;
  }

  await sock.sendMessage(jid, { text: newText, edit: key });
}

/**
 * Dispatch a semantic outbound event as WhatsApp messages.
 * Returns a MessageHandle for the last editable message sent (if any).
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} chatId
 * @param {OutboundEvent} event
 * @param {{ quoted?: BaileysMessage } | undefined} options
 * @param {import("../runtime/reaction-runtime.js").ReactionRuntime | undefined} reactionRuntime
 * @returns {Promise<MessageHandle | undefined>}
 */
export async function sendEvent(sock, chatId, event, options, reactionRuntime) {
  const rendered = renderOutboundEvent(event);
  if (!rendered) {
    return undefined;
  }
  return sendBlocks(sock, chatId, rendered.source, rendered.content, options, reactionRuntime, event);
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
 * @returns {Promise<MessageHandle | undefined>}
 */
export async function sendBlocks(sock, chatId, source, content, options, reactionRuntime, event) {
  const prefix = SOURCE_PREFIX[source];
  const blocks = typeof content === "string"
    ? [/** @type {ToolContentBlock} */ ({ type: "text", text: content })]
    : Array.isArray(content) ? content : [content];

  const instructions = await renderBlocks(blocks, prefix);

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
        await sock.sendMessage(chatId, {
          video: instruction.video,
          mimetype: instruction.mimetype,
          jpegThumbnail: "",
          ...(instruction.caption && { caption: instruction.caption }),
        }, options);
        break;
      case "audio":
        await sock.sendMessage(chatId, {
          audio: instruction.audio,
          mimetype: instruction.mimetype,
        }, options);
        break;
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
  const keyId = editKey.id ?? undefined;
  /** @type {MessageInspectState | null} */
  let inspectState = event?.kind === "tool_call"
    ? { kind: "tool", presentation: event.presentation }
    : null;

  /** @type {MessageHandle} */
  const handle = {
    keyId,
    isImage,
    update: async (update) => {
      const text = summarizeHandleUpdate(update);
      await editWhatsAppMessage(sock, chatId, editKey, `${prefix} ${text}`, isImage);
    },
    setInspect: (inspect) => {
      inspectState = inspect;
    },
  };

  if (keyId && reactionRuntime) {
    reactionRuntime.subscribe(keyId, (emoji) => {
      if (!emoji.startsWith("👁") || !inspectState) {
        return;
      }
      const inspect = formatInspectState(inspectState);
      void editWhatsAppMessage(
        sock,
        chatId,
        editKey,
        `${prefix} ${formatInspectEditText(inspect.summary, inspect.text)}`,
        isImage,
      );
    });
  }

  return handle;
}
