import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMessageActionContext } from "../execute-action-context.js";

describe("createMessageActionContext", () => {
  it("preserves current and quoted identity fields from a chat turn", () => {
    const context = createMessageActionContext({
      chatId: "chat-1",
      senderIds: ["current-user"],
      senderJids: ["current-user@s.whatsapp.net"],
      senderName: "Current User",
      chatName: "Chat",
      content: [{ type: "text", text: "hello" }],
      timestamp: new Date("2026-04-23T00:00:00.000Z"),
      facts: {
        isGroup: false,
        addressedToBot: false,
        repliedToBot: false,
        quotedSenderId: "quoted-user",
        quotedSenderJid: "quoted-user@s.whatsapp.net",
        quotedSenderName: "Quoted User",
      },
      io: {
        getIsAdmin: async () => true,
        send: async () => undefined,
        reply: async () => undefined,
        react: async () => {},
        select: async () => "",
        confirm: async () => true,
      },
    });

    assert.equal(context.senderName, "Current User");
    assert.deepEqual(context.senderJids, ["current-user@s.whatsapp.net"]);
    assert.equal(context.quotedSenderId, "quoted-user");
    assert.equal(context.quotedSenderJid, "quoted-user@s.whatsapp.net");
    assert.equal(context.quotedSenderName, "Quoted User");
  });
});
