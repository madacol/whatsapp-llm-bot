import assert from "node:assert/strict";
import { readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default [
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
];
