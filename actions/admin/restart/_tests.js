import assert from "node:assert/strict";

/** @type {ActionTestFn[]} */
export default [
  async function returns_restart_message(action_fn) {
    let replied = false;
    const result = await action_fn(
      { reply: async () => { replied = true; } },
      {},
    );
    assert.ok(replied, "should reply before restarting");
    assert.ok(typeof result === "string" && result.length > 0, "should return a message");
  },
];
