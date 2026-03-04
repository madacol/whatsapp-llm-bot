import assert from "node:assert/strict";

/** @type {ActionDbTestFn[]} */
export default [
async function executes_function_and_returns_result(action_fn, _db) {
      const result = await action_fn(
        { chatId: "rjs-1" },
        { code: "({chatId}) => chatId" },
      );
      assert.equal(result, "rjs-1");
    },
    async function throws_on_non_function_code(action_fn, _db) {
      await assert.rejects(
        async () => action_fn({}, { code: "42" }),
        { message: /function/ },
      );
    },
    async function throws_on_syntax_error(action_fn, _db) {
      await assert.rejects(
        async () => action_fn({}, { code: "{{invalid" }),
      );
    },
    async function resolveModel_is_available_on_context(action_fn, _db) {
      const mockResolveModel = (/** @type {string} */ role) => `model-for-${role}`;
      const result = await action_fn(
        { resolveModel: mockResolveModel },
        { code: "({resolveModel}) => resolveModel('coding')" },
      );
      assert.equal(result, "model-for-coding");
    },
];
