import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

async function pathExists(filePath) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

describe("legacy action system removal", () => {
  it("does not keep the obsolete filesystem action catalog", async () => {
    const repoRoot = process.cwd();
    const removedPaths = [
      "actions",
      "actions.js",
      "action-catalog.js",
      "chat-action-store.js",
    ];

    for (const relativePath of removedPaths) {
      assert.equal(
        await pathExists(path.join(repoRoot, relativePath)),
        false,
        `${relativePath} should not exist`,
      );
    }
  });

  it("keeps runtime source independent from the legacy action catalog", async () => {
    const repoRoot = process.cwd();
    const runtimeFiles = [
      "agent-runner.js",
      "conversation/build-harness-turn-input.js",
      "conversation/create-conversation-runner.js",
      "commands/bang-command-router.js",
      "message-formatting.js",
    ];

    for (const relativePath of runtimeFiles) {
      const text = await readFile(path.join(repoRoot, relativePath), "utf8");
      assert.equal(text.includes("actions.js"), false, `${relativePath} should not import actions.js`);
      assert.equal(text.includes("getActions"), false, `${relativePath} should not call getActions`);
      assert.equal(text.includes("getAction("), false, `${relativePath} should not call getAction`);
    }
  });
});
