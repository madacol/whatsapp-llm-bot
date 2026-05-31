import { contentEvent, textUpdate } from "../outbound-events.js";

export const WHATSAPP_ACP_REQUEST_METHODS = Object.freeze({
  send: "madabot/whatsapp/send",
  reply: "madabot/whatsapp/reply",
  edit: "madabot/whatsapp/edit",
  react: "madabot/whatsapp/react",
});

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function requireParams(value) {
  if (!isRecord(value)) {
    throw new Error("ACP WhatsApp request params must be an object.");
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {string}
 */
function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`ACP WhatsApp request requires non-empty ${name}.`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {value is MessageSource}
 */
function isMessageSource(value) {
  return value === "llm"
    || value === "tool-call"
    || value === "tool-result"
    || value === "error"
    || value === "warning"
    || value === "usage"
    || value === "memory"
    || value === "plain";
}

/**
 * @param {Record<string, unknown>} params
 * @returns {MessageSource}
 */
function parseSource(params) {
  if (params.source === undefined) {
    return "llm";
  }
  if (isMessageSource(params.source)) {
    return params.source;
  }
  throw new Error("ACP WhatsApp request source is invalid.");
}

/**
 * @param {Record<string, unknown>} params
 * @returns {SendContent}
 */
function parseContent(params) {
  if (typeof params.text === "string") {
    return params.text;
  }
  if (typeof params.markdown === "string") {
    return { type: "markdown", text: params.markdown };
  }
  throw new Error("ACP WhatsApp send/reply request requires text or markdown.");
}

/**
 * @param {string} handleId
 * @param {MessageHandle | undefined} handle
 * @returns {Record<string, unknown>}
 */
function handleResponse(handleId, handle) {
  return {
    ok: true,
    ...(handle ? { handleId } : {}),
    ...(handle?.deliveryStatus ? { deliveryStatus: handle.deliveryStatus } : {}),
    ...(handle?.transportHandleId ? { transportHandleId: handle.transportHandleId } : {}),
    ...(typeof handle?.queueId === "number" ? { queueId: handle.queueId } : {}),
  };
}

/**
 * Create ACP request handlers for WhatsApp-owned side effects. The request
 * payloads stay small and semantic; transport details remain inside TurnIO.
 * @param {Pick<TurnIO, "send" | "reply" | "react">} io
 * @returns {Map<string, AcpClientRequestHandler>}
 */
export function createWhatsAppAcpExtensionRequestHandlers(io) {
  /** @type {Map<string, MessageHandle>} */
  const handles = new Map();
  let nextHandleId = 1;

  /**
   * @param {MessageHandle | undefined} handle
   * @returns {Record<string, unknown>}
   */
  function rememberHandle(handle) {
    const handleId = String(nextHandleId);
    nextHandleId += 1;
    if (handle) {
      handles.set(handleId, handle);
    }
    return handleResponse(handleId, handle);
  }

  return new Map([
    [WHATSAPP_ACP_REQUEST_METHODS.send, async (message) => {
      const params = requireParams(message.params);
      return rememberHandle(await io.send(contentEvent(parseSource(params), parseContent(params))));
    }],
    [WHATSAPP_ACP_REQUEST_METHODS.reply, async (message) => {
      const params = requireParams(message.params);
      return rememberHandle(await io.reply(contentEvent(parseSource(params), parseContent(params))));
    }],
    [WHATSAPP_ACP_REQUEST_METHODS.edit, async (message) => {
      const params = requireParams(message.params);
      const handleId = requireString(params.handleId, "handleId");
      const text = requireString(params.text, "text");
      const handle = handles.get(handleId);
      if (!handle) {
        throw new Error(`ACP WhatsApp edit target was not found: ${handleId}`);
      }
      await handle.update(textUpdate(text));
      return { ok: true };
    }],
    [WHATSAPP_ACP_REQUEST_METHODS.react, async (message) => {
      const params = requireParams(message.params);
      await io.react(requireString(params.emoji, "emoji"));
      return { ok: true };
    }],
  ]);
}
