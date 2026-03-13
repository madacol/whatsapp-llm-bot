import assert from "node:assert/strict";

/** @type {ActionTestFn[]} */
export default [
  async function action_is_defined(action_fn) {
    assert.equal(typeof action_fn, "function");
  },
];
