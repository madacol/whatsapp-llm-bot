import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildRunConfig } from "../conversation/build-run-config.js";

describe("buildRunConfig", () => {
  /** @type {string | undefined} */
  let originalWorkspacesDir;
  /** @type {string} */
  let tempDir;

  beforeEach(async () => {
    originalWorkspacesDir = process.env.WORKSPACES_DIR;
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "build-run-config-"));
    process.env.WORKSPACES_DIR = tempDir;
  });

  afterEach(async () => {
    if (originalWorkspacesDir === undefined) {
      delete process.env.WORKSPACES_DIR;
    } else {
      process.env.WORKSPACES_DIR = originalWorkspacesDir;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("defaults sandbox mode to workspace-write", () => {
    const config = buildRunConfig("chat-1", undefined);

    assert.equal(config.sandboxMode, "workspace-write");
    assert.equal(typeof config.workdir, "string");
  });

  it("uses the chat name when building the default workspace path", () => {
    const config = buildRunConfig("chat-1", undefined, "Project Alpha");

    assert.equal(path.basename(config.workdir ?? ""), "Project Alpha--chat-1");
  });
});
