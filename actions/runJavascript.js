import assert from "node:assert/strict";

export default /** @type {defineAction} */ ((x) => x)({
  name: "run_javascript",
  command: "js",
  description:
    "Execute JavaScript code in a secure environment. The code must be an arrow function that receives a context object.",
  parameters: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description:
          "JavaScript code to execute (must be an arrow function that accepts a context parameter). Example: '({log, db}) => { log(\"Processing\"); return (await db.sql`SELECT * FROM table`).rows; }'",
      },
    },
    required: ["code"],
  },
  permissions: {
    autoExecute: true,
    autoContinue: true,
  },
  test_functions: [
    async function executes_function_and_returns_result(action_fn, _db) {
      const result = await action_fn(
        { chatId: "rjs-1" },
        { code: "({chatId}) => chatId" },
      );
      assert.equal(result, "rjs-1");
    },
    async function throws_on_non_function_code(action_fn, _db) {
      await assert.rejects(
        () => action_fn({}, { code: "42" }),
        { message: /function/ },
      );
    },
    async function throws_on_syntax_error(action_fn, _db) {
      await assert.rejects(
        () => action_fn({}, { code: "{{invalid" }),
      );
    },
  ],
  action_fn: async function (context, { code }) {
    // Handle both command args and LLM function call formats
    console.log("Executing JavaScript code:", JSON.stringify(code, null, 2));

    let fn;
    try {
      // Evaluate code
      fn = Function(`return ${code}`)();
    } catch (error) {
      console.error("Invalid JavaScript code: Is it a function?", {
        code,
        error,
      });
      throw error;
    }
    if (typeof fn !== "function") {
      console.error("fn is not a function:", { code, fn });
      throw new Error("Code must evaluate to a function");
    }
    try {
      return await fn(context);
    } catch (error) {
      console.error("Error executing function:", { code, fn, error });
      throw error;
    }
  },
});
