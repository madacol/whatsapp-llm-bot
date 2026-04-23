import assert from "node:assert/strict";

/** @type {ActionTestFn[]} */
export default [
  async function returns_current_user_identity(action_fn) {
    const result = await action_fn({
      senderIds: ["current-user"],
      senderJids: ["current-user@s.whatsapp.net"],
      senderName: "Current User",
    }, { target: "current" });

    assert.deepEqual(result, {
      display_name: "Current User",
      sender_id: "current-user",
      sender_jid: "current-user@s.whatsapp.net",
    });
  },
  async function returns_null_for_missing_quoted_identity(action_fn) {
    const result = await action_fn({
      senderIds: ["current-user"],
      senderJids: ["current-user@s.whatsapp.net"],
      senderName: "Current User",
    }, { target: "quoted" });

    assert.equal(result, null);
  },
];
