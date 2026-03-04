import { readFile } from "node:fs/promises";

const MAX_LINES = 4000;

export default /** @type {defineAction} */ ((x) => x)({
  name: "read_file",
  description:
    "Read a file from disk. Returns content with line numbers. Use offset/limit to read specific ranges of large files.",
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Absolute path to the file to read",
      },
      offset: {
        type: "integer",
        description: "1-based line number to start from (default: 1)",
      },
      limit: {
        type: "integer",
        description: "Maximum number of lines to return",
      },
    },
    required: ["file_path"],
  },
  instructions: `Use read_file instead of run_bash with cat/head/tail to read files. Always read a file before editing it.
- For large files, use offset and limit to read specific sections rather than the whole file.
- Line numbers in the output help you target edit_file replacements accurately.`,
  permissions: {
    requireMaster: true,
    autoExecute: true,
    autoContinue: true,
  },
  action_fn: async function (_context, { file_path, offset, limit }) {
    /** @type {string} */
    let content;
    try {
      content = await readFile(file_path, "utf-8");
    } catch (err) {
      return `Error reading file: ${/** @type {NodeJS.ErrnoException} */ (err).message}`;
    }

    const allLines = content.split("\n");
    const start = offset ? offset - 1 : 0;
    const end = limit ? start + limit : allLines.length;
    const cappedEnd = Math.min(end, start + MAX_LINES);
    const lines = allLines.slice(start, cappedEnd);

    const numbered = lines.map(
      (line, i) => `${start + i + 1}\t${line}`,
    );

    let result = numbered.join("\n");
    if (cappedEnd < allLines.length) {
      result += `\n\n... (${allLines.length - cappedEnd} more lines, ${allLines.length} total)`;
    }
    return result;
  },
});
