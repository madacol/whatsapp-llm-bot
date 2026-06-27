import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { getChannelId, withChannelIdentity } from "../conversation/channel-identity.js";

describe("Channel identity", () => {
  it("uses channelId when present and falls back to legacy chatId", () => {
    assert.equal(getChannelId({ channelId: "channel-1", chatId: "legacy-chat" }), "channel-1");
    assert.equal(getChannelId({ chatId: "legacy-chat" }), "legacy-chat");
  });

  it("normalizes touched app seams with a channelId", () => {
    assert.deepEqual(
      withChannelIdentity({ chatId: "api:client-1", senderName: "User" }),
      { chatId: "api:client-1", senderName: "User", channelId: "api:client-1" },
    );
  });
});
