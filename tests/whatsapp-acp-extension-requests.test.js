import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createWhatsAppAcpExtensionRequestHandlers,
  WHATSAPP_ACP_REQUEST_METHODS,
} from "../whatsapp/acp-extension-requests.js";

describe("WhatsApp ACP extension requests", () => {
  it("maps ACP WhatsApp send, edit, reply, and react requests to turn IO", async () => {
    /** @type {OutboundEvent[]} */
    const sent = [];
    /** @type {OutboundEvent[]} */
    const replies = [];
    /** @type {MessageHandleUpdate[]} */
    const updates = [];
    /** @type {string[]} */
    const reactions = [];

    const handlers = createWhatsAppAcpExtensionRequestHandlers({
      send: async (event) => {
        sent.push(event);
        return {
          transportHandleId: "transport-1",
          deliveryStatus: "sent",
          update: async (update) => {
            updates.push(update);
          },
          setInspect: () => {},
        };
      },
      reply: async (event) => {
        replies.push(event);
        return undefined;
      },
      react: async (emoji) => {
        reactions.push(emoji);
      },
    });

    const send = await handlers.get(WHATSAPP_ACP_REQUEST_METHODS.send)?.({
      method: WHATSAPP_ACP_REQUEST_METHODS.send,
      params: { text: "private send" },
    });
    await handlers.get(WHATSAPP_ACP_REQUEST_METHODS.edit)?.({
      method: WHATSAPP_ACP_REQUEST_METHODS.edit,
      params: { handleId: "1", text: "private edit" },
    });
    const reply = await handlers.get(WHATSAPP_ACP_REQUEST_METHODS.reply)?.({
      method: WHATSAPP_ACP_REQUEST_METHODS.reply,
      params: { markdown: "**private reply**" },
    });
    await handlers.get(WHATSAPP_ACP_REQUEST_METHODS.react)?.({
      method: WHATSAPP_ACP_REQUEST_METHODS.react,
      params: { emoji: "ok" },
    });

    assert.deepEqual(send, {
      ok: true,
      handleId: "1",
      deliveryStatus: "sent",
      transportHandleId: "transport-1",
    });
    assert.deepEqual(sent, [{
      kind: "content",
      source: "llm",
      content: "private send",
    }]);
    assert.deepEqual(updates, [{ kind: "text", text: "private edit" }]);
    assert.deepEqual(reply, { ok: true });
    assert.deepEqual(replies, [{
      kind: "content",
      source: "llm",
      content: { type: "markdown", text: "**private reply**" },
    }]);
    assert.deepEqual(reactions, ["ok"]);
  });
});
