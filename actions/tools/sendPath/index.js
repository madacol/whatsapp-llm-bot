import path from "node:path";
import { resolvePathToContentBlock } from "../../../outbound/path-to-content-block.js";

export default /** @type {defineAction} */ ((x) => x)({
  name: "send_path",
  description: "Send a local file or directory path back to WhatsApp. Directories are zipped first.",
  sharedSkill: {
    name: "send-path",
    description: "Return a generated file or folder to the chat by path.",
    instructions: `Use this skill when you need to return a generated artifact to the chat.
- Prefer workspace-relative paths when possible.
- Images are sent as images, audio as audio, video as video.
- Directories are zipped before sending.
- Any other file is sent as a generic document.
- In harnesses that expose the native action runtime, prefer calling \`send_path\` directly.`,
  },
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
  instructions: `Use send_path when you want to send a generated file or folder back to WhatsApp.
- Image, audio, and video paths are sent as their native WhatsApp media types.
- Directories are zipped first and sent as files.
- Any other file is sent as a generic WhatsApp document.`,
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
