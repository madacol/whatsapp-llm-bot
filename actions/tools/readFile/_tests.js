import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, rm } from "node:fs/promises";

export default [
async function reads_file_with_line_numbers(action_fn) {
      const tmp = join(tmpdir(), `readfile-test-${Date.now()}.txt`);
      await writeFile(tmp, "alpha\nbeta\ngamma\n");
      try {
        const result = await action_fn({}, { file_path: tmp });
        assert.match(result, /1\talpha/);
        assert.match(result, /2\tbeta/);
        assert.match(result, /3\tgamma/);
      } finally {
        await rm(tmp);
      }
    },
    async function respects_offset_and_limit(action_fn) {
      const tmp = join(tmpdir(), `readfile-test-${Date.now()}.txt`);
      await writeFile(tmp, "a\nb\nc\nd\ne\n");
      try {
        const result = await action_fn(
          {},
          { file_path: tmp, offset: 2, limit: 2 },
        );
        assert.ok(!result.includes("1\ta"));
        assert.match(result, /2\tb/);
        assert.match(result, /3\tc/);
        assert.ok(!result.includes("4\td"));
      } finally {
        await rm(tmp);
      }
    },
    async function returns_error_for_missing_file(action_fn) {
      const result = await action_fn(
        {},
        { file_path: "/tmp/nonexistent-readfile-test.txt" },
      );
      assert.match(result, /Error/);
    },
];
