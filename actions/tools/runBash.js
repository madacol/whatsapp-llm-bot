import assert from "node:assert/strict";
import { execFile } from "node:child_process";

const DEFAULT_TIMEOUT = 30_000;
const MAX_BUFFER = 1024 * 1024;

/**
 * Run a shell command and return a promise with stdout, stderr, and exit code.
 * @param {string} command
 * @param {{ timeout?: number }} [options]
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number, killed: boolean }>}
 */
function runCommand(command, { timeout = DEFAULT_TIMEOUT } = {}) {
  return new Promise((resolve) => {
    execFile(
      "/bin/sh",
      ["-c", command],
      { timeout, maxBuffer: MAX_BUFFER },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            stdout,
            stderr,
            exitCode: error.code ?? 1,
            killed: error.killed ?? false,
          });
        } else {
          resolve({ stdout, stderr, exitCode: 0, killed: false });
        }
      },
    );
  });
}

/**
 * Format the result of a shell command execution.
 * @param {{ stdout: string, stderr: string, exitCode: number, killed: boolean }} result
 * @returns {string}
 */
function formatResult({ stdout, stderr, exitCode, killed }) {
  if (killed) {
    return "Command timed out and was killed.";
  }
  const parts = [`Exit code: ${exitCode}`];
  if (stdout) parts.push(`stdout:\n${stdout}`);
  if (stderr) parts.push(`stderr:\n${stderr}`);
  return parts.join("\n");
}

export default /** @type {defineAction} */ ((x) => x)({
  name: "run_bash",
  command: "bash",
  description:
    "Run a shell command on the host machine. Returns stdout, stderr, and exit code.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The shell command to execute",
      },
    },
    required: ["command"],
  },
  permissions: {
    requireMaster: true,
    autoContinue: true,
  },
  test_functions: [
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
  ],
  action_fn: async function (_context, { command, timeout }) {
    const result = await runCommand(command, { timeout });
    return formatResult(result);
  },
});
