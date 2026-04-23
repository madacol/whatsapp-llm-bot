import { describe, it } from "node:test";
import assert from "node:assert/strict";
import action from "../actions/tools/getUserIdentity/index.js";

describe("get_user_identity action", () => {
  it("returns the current sender identity on demand", async () => {
    const result = await action.action_fn({
      senderIds: ["current-user"],
      senderJids: ["current-user@s.whatsapp.net"],
      senderName: "Current User",
    }, { target: "current" });

    assert.deepEqual(result, {
      display_name: "Current User",
      sender_id: "current-user",
      sender_jid: "current-user@s.whatsapp.net",
    });
  });

  it("returns quoted sender identity when present", async () => {
    const result = await action.action_fn({
      senderIds: ["current-user"],
      senderJids: ["current-user@s.whatsapp.net"],
      senderName: "Current User",
      quotedSenderId: "quoted-user",
      quotedSenderJid: "quoted-user@s.whatsapp.net",
      quotedSenderName: "Quoted User",
    }, { target: "quoted" });

    assert.deepEqual(result, {
      display_name: "Quoted User",
      sender_id: "quoted-user",
      sender_jid: "quoted-user@s.whatsapp.net",
    });
  });

  it("returns null for quoted identity when the turn has no quote", async () => {
    const result = await action.action_fn({
      senderIds: ["current-user"],
      senderJids: ["current-user@s.whatsapp.net"],
      senderName: "Current User",
    }, { target: "quoted" });

    assert.equal(result, null);
  });
});
