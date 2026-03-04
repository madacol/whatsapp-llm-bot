import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export default /** @type {defineAction} */ ((x) => x)({
  name: "write_file",
  description:
    "Create or overwrite a file with the given content. Creates parent directories if needed.",
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Absolute path to the file to write",
      },
      content: {
        type: "string",
        description: "The full content to write to the file",
      },
    },
    required: ["file_path", "content"],
  },
  formatToolCall: ({ file_path }) => `Writing ${file_path?.split("/").pop() ?? "file"}`,
  instructions: `Use write_file to create new files or completely rewrite existing ones.
- For modifying parts of an existing file, prefer edit_file — it's safer and uses less context.
- write_file overwrites the entire file, so include the full desired content.`,
  permissions: {
    requireMaster: true,
    autoExecute: true,
    autoContinue: true,
  },
  action_fn: async function (_context, { file_path, content }) {
    try {
      await mkdir(dirname(file_path), { recursive: true });
      await writeFile(file_path, content, "utf-8");
    } catch (err) {
      return `Error writing file: ${/** @type {NodeJS.ErrnoException} */ (err).message}`;
    }

    const lines = content.split("\n").length;
    return `Wrote ${lines} line${lines === 1 ? "" : "s"} to ${file_path}`;
  },
});
