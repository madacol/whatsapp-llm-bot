import { readFile, writeFile } from "node:fs/promises";

export default /** @type {defineAction} */ ((x) => x)({
  name: "edit_file",
  description:
    "Find and replace a unique string in a file. Fails if old_string is not found or appears more than once.",
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Absolute path to the file to edit",
      },
      old_string: {
        type: "string",
        description: "Exact text to find (must appear exactly once)",
      },
      new_string: {
        type: "string",
        description: "Replacement text",
      },
    },
    required: ["file_path", "old_string", "new_string"],
  },
  instructions: `Use edit_file instead of run_bash with sed/awk for file edits. Always read_file first so you know the exact content.
- old_string must match exactly (whitespace, indentation, newlines). Copy it from read_file output.
- If old_string is ambiguous (appears multiple times), include more surrounding context to make it unique.
- To delete code, set new_string to an empty string.
- For creating new files, use write_file instead.`,
  permissions: {
    requireMaster: true,
    autoExecute: true,
    autoContinue: true,
  },
  action_fn: async function (_context, { file_path, old_string, new_string }) {
    /** @type {string} */
    let content;
    try {
      content = await readFile(file_path, "utf-8");
    } catch (err) {
      return `Error reading file: ${/** @type {NodeJS.ErrnoException} */ (err).message}`;
    }

    // Count occurrences
    let count = 0;
    let idx = -1;
    let searchFrom = 0;
    while ((idx = content.indexOf(old_string, searchFrom)) !== -1) {
      count++;
      searchFrom = idx + old_string.length;
    }

    if (count === 0) {
      return `Error: old_string not found in ${file_path}. Make sure the string matches exactly, including whitespace and indentation.`;
    }
    if (count > 1) {
      return `Error: old_string found ${count} times in ${file_path}. Provide a larger, unique snippet to avoid ambiguity.`;
    }

    // Find the line number of the match
    const matchIndex = content.indexOf(old_string);
    const lineNumber = content.substring(0, matchIndex).split("\n").length;

    const updated = content.replace(old_string, new_string);
    await writeFile(file_path, updated, "utf-8");

    const linesReplaced = new_string.split("\n").length;
    return `Replaced at line ${lineNumber} (${linesReplaced} line${linesReplaced === 1 ? "" : "s"}) in ${file_path}`;
  },
});
