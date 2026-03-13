import { execFile } from "node:child_process";

export default /** @type {defineAction} */ ((x) => x)({
  name: "restart",
  command: "restart",
  description: "Restart the bot process",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  formatToolCall: () => "Restarting bot…",
  permissions: {
    requireMaster: true,
    autoExecute: true,
    autoContinue: true,
  },
  action_fn: async function () {
    // Fire and forget — the process will die before we can return
    execFile("pnpm", ["run", "restart"], { cwd: process.cwd() });
    return "Restart signal sent.";
  },
});
