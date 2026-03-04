import assert from "node:assert/strict";

/** @type {ActionTestFn[]} */
export default [
async function executes_command_and_returns_stdout(action_fn) {
      const result = await action_fn({}, { command: "echo hello" });
      assert.match(result, /hello/);
    },
    async function captures_stderr(action_fn) {
      const result = await action_fn({}, { command: "echo err >&2" });
      assert.match(result, /err/);
    },
    async function returns_exit_code_on_failure(action_fn) {
      const result = await action_fn({}, { command: "exit 42" });
      assert.match(result, /42/);
    },
    async function times_out_long_running_commands(action_fn) {
      const result = await action_fn(
        {},
        { command: "sleep 60", timeout: 100 },
      );
      assert.match(result, /timed out/i);
    },
];
