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

  it("reads the active harness namespace instead of a shared model field", () => {
    const config = buildRunConfig("chat-1", /** @type {import("../store.js").ChatRow} */ ({
      chat_id: "chat-1",
      harness: "codex",
      harness_cwd: null,
      harness_config: {
        codex: { model: "gpt-5.4", sandboxMode: "danger-full-access" },
        "claude-agent-sdk": { model: "claude-sonnet-4-6", reasoningEffort: "medium" },
      },
    }), "Project Alpha", "codex");

    assert.equal(config.model, "gpt-5.4");
    assert.equal(config.sandboxMode, "danger-full-access");
    assert.equal(config.reasoningEffort, undefined);
  });

  it("does not leak a legacy Claude model into Codex runs", () => {
    const codexConfig = buildRunConfig("chat-1", /** @type {import("../store.js").ChatRow} */ ({
      chat_id: "chat-1",
      harness: "codex",
      harness_cwd: null,
      harness_config: { model: "sonnet" },
    }), "Project Alpha", "codex");
    const claudeConfig = buildRunConfig("chat-1", /** @type {import("../store.js").ChatRow} */ ({
      chat_id: "chat-1",
      harness: "codex",
      harness_cwd: null,
      harness_config: { model: "sonnet" },
    }), "Project Alpha", "claude-agent-sdk");

    assert.equal(codexConfig.model, undefined);
    assert.equal(claudeConfig.model, "sonnet");
  });
});
