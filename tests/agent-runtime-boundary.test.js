import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

describe("Agent Runtime seam", () => {
  it("keeps harness internals behind the Agent Runtime facade", async () => {
    const source = await readFile(new URL("../conversation/create-conversation-runner.js", import.meta.url), "utf8");

    const forbiddenImports = [
      "from \"#harnesses\"",
      "from '../harness-config.js'",
      "from \"../harness-config.js\"",
      "from './build-harness-turn-input.js'",
      "from \"./build-harness-turn-input.js\"",
      "from './harness-session-binding.js'",
      "from \"./harness-session-binding.js\"",
    ];

    for (const forbidden of forbiddenImports) {
      assert.equal(source.includes(forbidden), false, `create-conversation-runner.js should not import ${forbidden}`);
    }
  });
});
