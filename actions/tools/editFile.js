import assert from "node:assert/strict";
import { readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  permissions: {
    requireMaster: true,
    autoExecute: true,
    autoContinue: true,
  },
  test_functions: [
    async function replaces_unique_match(action_fn) {
      const tmp = join(tmpdir(), `editfile-test-${Date.now()}.txt`);
      await writeFile(tmp, "hello world\ngoodbye world\n");
      try {
        const result = await action_fn(
          {},
          { file_path: tmp, old_string: "hello", new_string: "hi" },
        );
        assert.match(result, /line 1/i);
        const content = await readFile(tmp, "utf-8");
        assert.ok(content.includes("hi world"));
        assert.ok(!content.includes("hello"));
      } finally {
        await rm(tmp);
      }
    },
    async function fails_on_no_match(action_fn) {
      const tmp = join(tmpdir(), `editfile-test-${Date.now()}.txt`);
      await writeFile(tmp, "hello world\n");
      try {
        const result = await action_fn(
          {},
          { file_path: tmp, old_string: "missing", new_string: "x" },
        );
        assert.match(result, /not found/i);
      } finally {
        await rm(tmp);
      }
    },
    async function fails_on_ambiguous_match(action_fn) {
      const tmp = join(tmpdir(), `editfile-test-${Date.now()}.txt`);
      await writeFile(tmp, "aaa\naaa\n");
      try {
        const result = await action_fn(
          {},
          { file_path: tmp, old_string: "aaa", new_string: "bbb" },
        );
        assert.match(result, /2 times/i);
      } finally {
        await rm(tmp);
      }
    },
  ],
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
