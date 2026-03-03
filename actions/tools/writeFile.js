import assert from "node:assert/strict";
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

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
  instructions: `Use write_file to create new files or completely rewrite existing ones.
- For modifying parts of an existing file, prefer edit_file — it's safer and uses less context.
- write_file overwrites the entire file, so include the full desired content.`,
  permissions: {
    requireMaster: true,
    autoExecute: true,
    autoContinue: true,
  },
  test_functions: [
    async function creates_new_file(action_fn) {
      const tmp = join(tmpdir(), `writefile-test-${Date.now()}.txt`);
      try {
        const result = await action_fn(
          {},
          { file_path: tmp, content: "hello\nworld\n" },
        );
        assert.match(result, /wrote/i);
        const content = await readFile(tmp, "utf-8");
        assert.equal(content, "hello\nworld\n");
      } finally {
        await rm(tmp, { force: true });
      }
    },
    async function overwrites_existing_file(action_fn) {
      const tmp = join(tmpdir(), `writefile-test-${Date.now()}.txt`);
      await writeFile(tmp, "old content");
      try {
        await action_fn({}, { file_path: tmp, content: "new content" });
        const content = await readFile(tmp, "utf-8");
        assert.equal(content, "new content");
      } finally {
        await rm(tmp, { force: true });
      }
    },
    async function creates_parent_directories(action_fn) {
      const dir = join(tmpdir(), `writefile-nested-${Date.now()}`);
      const tmp = join(dir, "sub", "file.txt");
      try {
        const result = await action_fn(
          {},
          { file_path: tmp, content: "nested" },
        );
        assert.match(result, /wrote/i);
        const content = await readFile(tmp, "utf-8");
        assert.equal(content, "nested");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  ],
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
