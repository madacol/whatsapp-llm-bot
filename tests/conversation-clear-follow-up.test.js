import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildClearCommandFollowUp } from "../conversation/clear-command-follow-up.js";

describe("clear command follow-up", () => {
  it("turns a clear command with trailing prompt into an addressed follow-up turn", () => {
    /** @type {ChannelInput} */
    const turn = {
      chatId: "chat-1",
      senderIds: ["user-1"],
      senderName: "User",
      chatName: "Chat",
      timestamp: new Date("2026-06-16T00:00:00Z"),
      facts: {
        isGroup: true,
        addressedToBot: false,
        repliedToBot: false,
      },
      content: [
        { type: "text", text: "/clear summarize this image" },
        { type: "image", path: ".media/example.jpg", mime_type: "image/jpeg" },
      ],
      io: {
        send: async () => undefined,
        reply: async () => undefined,
        select: async () => "",
        selectMany: async () => ({ kind: "cancelled" }),
        confirm: async () => false,
        react: async () => {},
        getIsAdmin: async () => false,
        prepareMediaRegistry: () => {},
      },
    };

    const firstBlock = turn.content[0];
    if (firstBlock?.type !== "text") {
      assert.fail("expected first content block to be text");
    }
    const followUp = buildClearCommandFollowUp(turn, firstBlock, "/")?.followUpTurn;

    assert.ok(followUp);
    assert.equal(followUp.facts.addressedToBot, true);
    assert.deepEqual(followUp.content, [
      { type: "text", text: "summarize this image" },
      { type: "image", path: ".media/example.jpg", mime_type: "image/jpeg" },
    ]);
  });
});
