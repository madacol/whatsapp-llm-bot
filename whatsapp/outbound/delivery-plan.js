import { renderBlocks } from "../../message-renderer.js";

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
 * @typedef {{
 *   id: string;
 *   kind: "send_text";
 *   text: string;
 *   editable: boolean;
 *   continuation?: import("../../message-renderer.js").RenderedImagesContinuation;
 * }} WhatsAppSendTextStep
 *
 * @typedef {{
 *   id: string;
 *   kind: "send_image";
 *   image: Buffer;
 *   caption?: string;
 *   editable: boolean;
 *   hd?: boolean;
 *   debug?: import("../../message-renderer.js").AttachmentDebugInfo;
 * }} WhatsAppSendImageStep
 *
 * @typedef {{
 *   id: string;
 *   kind: "send_album";
 *   items: Array<{ image: Buffer, caption?: string, debug?: import("../../message-renderer.js").AttachmentDebugInfo }>;
 *   editable: boolean;
 * }} WhatsAppSendAlbumStep
 *
 * @typedef {{
 *   id: string;
 *   kind: "send_video";
 *   video: Buffer;
 *   mimetype: string;
 *   caption?: string;
 *   debug?: import("../../message-renderer.js").AttachmentDebugInfo;
 * }} WhatsAppSendVideoStep
 *
 * @typedef {{
 *   id: string;
 *   kind: "send_audio";
 *   audio: Buffer;
 *   mimetype: string;
 *   debug?: import("../../message-renderer.js").AttachmentDebugInfo;
 * }} WhatsAppSendAudioStep
 *
 * @typedef {{
 *   id: string;
 *   kind: "send_file";
 *   file: Buffer;
 *   mimetype: string;
 *   fileName: string;
 *   caption?: string;
 *   debug?: import("../../message-renderer.js").AttachmentDebugInfo;
 * }} WhatsAppSendFileStep
 *
 * @typedef {{
 *   id?: string | null;
 *   remoteJid?: string | null;
 *   fromMe?: boolean | null;
 * }} WhatsAppDeliveryMessageKey
 *
 * @typedef {{
 *   id: string;
 *   kind: "edit_text";
 *   text: string;
 *   target: {
 *     messageKey?: WhatsAppDeliveryMessageKey;
 *     messageKind?: "text" | "image";
 *     fallbackKeyId?: string;
 *   };
 * }} WhatsAppEditTextStep
 *
 * @typedef {{
 *   id: string;
 *   kind: "send_reaction";
 *   text: string;
 *   target: WhatsAppDeliveryMessageKey;
 * }} WhatsAppSendReactionStep
 *
 * @typedef {{
 *   id: string;
 *   kind: "pin_message" | "unpin_message";
 *   target: WhatsAppDeliveryMessageKey;
 * }} WhatsAppPinMessageStep
 *
 * @typedef {WhatsAppSendTextStep | WhatsAppSendImageStep | WhatsAppSendAlbumStep | WhatsAppSendVideoStep | WhatsAppSendAudioStep | WhatsAppSendFileStep | WhatsAppEditTextStep | WhatsAppSendReactionStep | WhatsAppPinMessageStep} WhatsAppDeliveryStep
 *
 * @typedef {{
 *   steps: WhatsAppDeliveryStep[];
 *   editableStepId?: string;
 *   editableMessageKind?: "text" | "image";
 *   sourcePrefix?: string;
 * }} WhatsAppDeliveryPlan
 */

/**
 * @param {MessageSource} source
 * @returns {string}
 */
export function getWhatsAppSourcePrefix(source) {
  return SOURCE_PREFIX[source];
}

/**
 * @param {string} prefix
 * @param {string} text
 * @returns {string}
 */
export function prependWhatsAppSourcePrefix(prefix, text) {
  return prefix ? `${prefix} ${text}` : text;
}

/**
 * @param {{ text: string, editable?: boolean }} input
 * @returns {WhatsAppDeliveryPlan}
 */
export function buildWhatsAppTextDeliveryPlan({ text, editable = false }) {
  return {
    steps: [{
      id: "step-1",
      kind: "send_text",
      text,
      editable,
    }],
    ...(editable ? { editableStepId: "step-1", editableMessageKind: "text" } : {}),
  };
}

/**
 * @param {import("../../message-renderer.js").SendInstruction} instruction
 * @param {string} id
 * @returns {WhatsAppDeliveryStep}
 */
function instructionToStep(instruction, id) {
  switch (instruction.kind) {
    case "text":
      return {
        id,
        kind: "send_text",
        text: instruction.text,
        editable: instruction.editable,
        ...(instruction.continuation ? { continuation: instruction.continuation } : {}),
      };
    case "image":
      return {
        id,
        kind: "send_image",
        image: instruction.image,
        ...(instruction.caption ? { caption: instruction.caption } : {}),
        editable: instruction.editable,
        ...(instruction.hd ? { hd: true } : {}),
        ...(instruction.debug ? { debug: instruction.debug } : {}),
      };
    case "video":
      return {
        id,
        kind: "send_video",
        video: instruction.video,
        mimetype: instruction.mimetype,
        ...(instruction.caption ? { caption: instruction.caption } : {}),
        ...(instruction.debug ? { debug: instruction.debug } : {}),
      };
    case "audio":
      return {
        id,
        kind: "send_audio",
        audio: instruction.audio,
        mimetype: instruction.mimetype,
        ...(instruction.debug ? { debug: instruction.debug } : {}),
      };
    case "file":
      return {
        id,
        kind: "send_file",
        file: instruction.file,
        mimetype: instruction.mimetype,
        fileName: instruction.fileName,
        ...(instruction.caption ? { caption: instruction.caption } : {}),
        ...(instruction.debug ? { debug: instruction.debug } : {}),
      };
  }
  throw new Error(`Unsupported WhatsApp send instruction: ${/** @type {{ kind?: string }} */ (instruction).kind ?? "unknown"}`);
}

/**
 * @param {import("../../message-renderer.js").SendInstruction & { kind: "image" }} instruction
 * @returns {{ image: Buffer, caption?: string, debug?: import("../../message-renderer.js").AttachmentDebugInfo }}
 */
function imageInstructionToAlbumItem(instruction) {
  return {
    image: instruction.image,
    ...(instruction.caption ? { caption: instruction.caption } : {}),
    ...(instruction.debug ? { debug: instruction.debug } : {}),
  };
}

/**
 * @param {WhatsAppDeliveryPlan} plan
 * @param {WhatsAppDeliveryStep} step
 * @returns {void}
 */
function rememberEditableStep(plan, step) {
  if (step.kind !== "send_text" && step.kind !== "send_image" && step.kind !== "send_album") {
    return;
  }
  if (!step.editable) {
    return;
  }
  plan.editableStepId = step.id;
  plan.editableMessageKind = step.kind === "send_text" ? "text" : "image";
}

/**
 * @param {{
 *   instructions: import("../../message-renderer.js").SendInstruction[];
 *   sourcePrefix?: string;
 * }} input
 * @returns {WhatsAppDeliveryPlan}
 */
export function buildWhatsAppInstructionDeliveryPlan({ instructions, sourcePrefix = "" }) {
  /** @type {WhatsAppDeliveryPlan} */
  const plan = {
    steps: [],
    ...(sourcePrefix ? { sourcePrefix } : {}),
  };
  const totalImageCount = instructions.filter((instruction) => instruction.kind === "image").length;
  let nextStepNumber = 1;

  /**
   * @param {WhatsAppDeliveryStep} step
   * @returns {void}
   */
  function pushStep(step) {
    plan.steps.push(step);
    rememberEditableStep(plan, step);
  }

  if (totalImageCount < 2) {
    for (const instruction of instructions) {
      pushStep(instructionToStep(instruction, `step-${nextStepNumber++}`));
    }
    return plan;
  }

  /** @type {Array<import("../../message-renderer.js").SendInstruction & { kind: "image" }>} */
  let imageRun = [];

  /**
   * @returns {void}
   */
  function flushImageRun() {
    if (imageRun.length === 0) {
      return;
    }
    if (imageRun.length === 1) {
      pushStep(instructionToStep(imageRun[0], `step-${nextStepNumber++}`));
      imageRun = [];
      return;
    }
    pushStep({
      id: `step-${nextStepNumber++}`,
      kind: "send_album",
      items: imageRun.map(imageInstructionToAlbumItem),
      editable: imageRun[0]?.editable ?? false,
    });
    imageRun = [];
  }

  for (const instruction of instructions) {
    if (instruction.kind === "image") {
      imageRun.push(instruction);
      continue;
    }
    flushImageRun();
    pushStep(instructionToStep(instruction, `step-${nextStepNumber++}`));
  }
  flushImageRun();
  return plan;
}

/**
 * @param {{
 *   source: MessageSource;
 *   content: SendContent;
 *   renderOptions?: { workdir?: string | null };
 * }} input
 * @returns {Promise<WhatsAppDeliveryPlan>}
 */
export async function buildWhatsAppContentDeliveryPlan({ source, content, renderOptions = {} }) {
  const prefix = getWhatsAppSourcePrefix(source);
  const blocks = typeof content === "string"
    ? [/** @type {ToolContentBlock} */ ({ type: "text", text: content })]
    : Array.isArray(content) ? content : [content];
  const instructions = await renderBlocks(blocks, prefix, renderOptions);
  return buildWhatsAppInstructionDeliveryPlan({ instructions, sourcePrefix: prefix });
}

/**
 * @param {{
 *   text: string;
 *   target: WhatsAppEditTextStep["target"];
 * }} input
 * @returns {WhatsAppDeliveryPlan}
 */
export function buildWhatsAppEditDeliveryPlan({ text, target }) {
  return {
    steps: [{
      id: "step-1",
      kind: "edit_text",
      text,
      target,
    }],
  };
}

/**
 * @param {{
 *   text: string;
 *   target: WhatsAppDeliveryMessageKey;
 * }} input
 * @returns {WhatsAppDeliveryPlan}
 */
export function buildWhatsAppReactionDeliveryPlan({ text, target }) {
  return {
    steps: [{
      id: "step-1",
      kind: "send_reaction",
      text,
      target,
    }],
  };
}

/**
 * @param {{
 *   action: "pin" | "unpin";
 *   target: WhatsAppDeliveryMessageKey;
 * }} input
 * @returns {WhatsAppDeliveryPlan}
 */
export function buildWhatsAppPinDeliveryPlan({ action, target }) {
  return {
    steps: [{
      id: "step-1",
      kind: action === "pin" ? "pin_message" : "unpin_message",
      target,
    }],
  };
}
