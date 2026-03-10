import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const actionsDir = path.resolve(process.cwd(), "actions");
const subDir = path.join(actionsDir, "_test_sub");
const subActionPath = path.join(subDir, "testSubAction.js");

before(async () => {
  await fs.mkdir(subDir, { recursive: true });
  await fs.writeFile(
    subActionPath,
    `export default {
      name: "test_sub_action",
      description: "Test action in subdirectory",
      parameters: { type: "object", properties: {} },
      permissions: { autoExecute: true },
      action_fn: async () => "ok",
    };`,
  );
});

after(async () => {
  await fs.rm(subDir, { recursive: true, force: true });
});

describe("recursive action loader", () => {
  it("discovers actions in subdirectories", async () => {
    // Dynamic import to get a fresh getActions after the temp file is created
    const { getActions } = await import("../actions.js");
    const actions = await getActions();
    const names = actions.map((a) => a.name);
    assert.ok(
      names.includes("test_sub_action"),
      `Expected "test_sub_action" in ${JSON.stringify(names)}`,
    );
  });

  it("skips files starting with _ even in subdirectories", async () => {
    const underscoreFile = path.join(subDir, "_helper.js");
    await fs.writeFile(
      underscoreFile,
      `export default { name: "should_not_load" };`,
    );
    try {
      const { getActions } = await import("../actions.js");
      const actions = await getActions();
      const names = actions.map((a) => a.name);
      assert.ok(
        !names.includes("should_not_load"),
        `"should_not_load" should have been skipped`,
      );
    } finally {
      await fs.rm(underscoreFile, { force: true });
    }
  });
});
