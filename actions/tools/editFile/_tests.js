import assert from "node:assert/strict";
import { readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default [
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
];
