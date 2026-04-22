import path from "node:path";
import { resolvePathToContentBlock } from "../../../outbound/path-to-content-block.js";

export default /** @type {defineAction} */ ((x) => x)({
  name: "send_path",
  description: "Send a local file or directory path back to the user. Directories are zipped first.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute or workspace-relative path to a file or directory to send",
      },
    },
    required: ["path"],
  },
  formatToolCall: ({ path: inputPath }) => `Sending ${typeof inputPath === "string" ? path.basename(inputPath) : "path"}`,
  instructions: `Use send_path when you want to send a generated file or folder back to the user.
- Image, audio, and video paths are sent as native media types.
- Directories are zipped first and sent as files.
- Any other file is sent as a generic document.`,
  permissions: {
    requireMaster: true,
    autoExecute: true,
    autoContinue: true,
  },
  action_fn: async function (context, { path: inputPath }) {
    if (typeof inputPath !== "string" || !inputPath.trim()) {
      return "Error sending path: missing path";
    }

    try {
      const block = await resolvePathToContentBlock(inputPath, {
        workdir: context.workdir ?? null,
      });
      return { result: [block] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Error sending path: ${message}`;
    }
  },
});
