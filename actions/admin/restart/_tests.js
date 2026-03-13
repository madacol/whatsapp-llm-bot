import assert from "node:assert/strict";

/** @type {ActionTestFn[]} */
export default [
  async function returns_restart_message(action_fn) {
    const result = await action_fn({}, {});
    assert.ok(typeof result === "string" && result.length > 0, "should return a message");
  },
];
