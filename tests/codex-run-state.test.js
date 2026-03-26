import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeCodexFileChange } from "../harnesses/codex-file-events.js";
import { createCodexRunState } from "../harnesses/codex-run-state.js";

describe("normalizeCodexFileChange", () => {
  it("logs the raw and normalized file-change payload when Codex provides a diff", () => {
    const rawItem = {
      type: "file_change",
      changes: [{ path: "src/app.js", kind: "update" }],
      patch: [
        "--- a/src/app.js",
        "+++ b/src/app.js",
        "@@ -1 +1 @@",
        "-old",
        "+new",
      ].join("\n"),
    };

    const calls = captureDebugLogs(() => {
      assert.deepEqual(normalizeCodexFileChange(rawItem), {
        path: "src/app.js",
        summary: "src/app.js (update)",
        kind: "update",
        diff: rawItem.patch,
      });
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.[0], "[harness:codex-file-events]");
    assert.equal(calls[0]?.[1], "Normalized Codex file change payload");
    assert.deepEqual(calls[0]?.[2], {
      input: rawItem,
      output: {
        path: "src/app.js",
        summary: "src/app.js (update)",
        kind: "update",
        diff: rawItem.patch,
      },
    });
  });
});

describe("createCodexRunState", () => {
  it("logs when the diff comes directly from the Codex event payload", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-run-state-direct-"));
    await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "src/app.js"), "new\n", "utf8");

    const state = createCodexRunState({ workdir: tempDir });
    const input = {
      path: "src/app.js",
      summary: "src/app.js (update)",
      kind: "update",
      diff: [
        "--- a/src/app.js",
        "+++ b/src/app.js",
        "@@ -1 +1 @@",
        "-old",
        "+new",
      ].join("\n"),
    };

    const calls = await captureDebugLogsAsync(async () => {
      const enriched = await state.enrichFileChangeEvent(input);
      assert.deepEqual(enriched, {
        ...input,
        oldText: "old\n",
        newText: "new\n",
      });
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.[0], "[harness:codex-run-state]");
    assert.equal(calls[0]?.[1], "Enriched Codex file change");
    assert.equal(calls[0]?.[2]?.diffSource, "event");
    assert.deepEqual(calls[0]?.[2]?.input, input);
  });

  it("logs when the diff comes from a parsed apply_patch command", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-run-state-patch-"));
    await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
    const filePath = path.join(tempDir, "src/app.js");
    await fs.writeFile(filePath, "old\n", "utf8");

    const state = createCodexRunState({ workdir: tempDir });
    await state.handleCommandEvent({
      command: [
        "apply_patch <<'PATCH'",
        "*** Begin Patch",
        "*** Update File: src/app.js",
        "@@",
        "-old",
        "+new",
        "*** End Patch",
        "PATCH",
      ].join("\n"),
      status: "started",
    });
    await fs.writeFile(filePath, "new\n", "utf8");

    const calls = await captureDebugLogsAsync(async () => {
      const enriched = await state.enrichFileChangeEvent({
        path: "src/app.js",
        summary: "src/app.js (update)",
      });
      assert.deepEqual(enriched, {
        path: "src/app.js",
        summary: "src/app.js (update)",
        kind: "update",
        oldText: "old\n",
        newText: "new\n",
        diff: [
          "--- a/src/app.js",
          "+++ b/src/app.js",
          "@@",
          "-old",
          "+new",
        ].join("\n"),
      });
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.[2]?.diffSource, "apply_patch");
  });

  it("logs when the diff is synthesized from filesystem snapshots", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-run-state-snapshot-"));
    await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
    const filePath = path.join(tempDir, "src/app.js");
    await fs.writeFile(filePath, "const value = 1;\n", "utf8");

    const state = createCodexRunState({ workdir: tempDir });
    await state.handleCommandEvent({
      command: "sed -n '1,20p' src/app.js",
      status: "started",
    });
    await fs.writeFile(filePath, "const value = 2;\n", "utf8");

    const calls = await captureDebugLogsAsync(async () => {
      const enriched = await state.enrichFileChangeEvent({
        path: "src/app.js",
        summary: "src/app.js (update)",
      });
      assert.equal(enriched.kind, "update");
      assert.equal(enriched.oldText, "const value = 1;\n");
      assert.equal(enriched.newText, "const value = 2;\n");
      assert.equal(enriched.diff, [
        "--- a/src/app.js",
        "+++ b/src/app.js",
        "@@ -1,1 +1,1 @@",
        "-const value = 1;",
        "+const value = 2;",
      ].join("\n"));
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.[2]?.diffSource, "filesystem");
  });

  it("computes an add diff for a live SDK file_change without prior commands", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-run-state-live-add-"));
    const filePath = path.join(tempDir, "added.txt");
    await fs.writeFile(filePath, "hello from codex\n", "utf8");

    const state = createCodexRunState({ workdir: tempDir });
    const enriched = await state.enrichFileChangeEvent({
      path: "added.txt",
      summary: "added.txt (add)",
      kind: "add",
    });

    assert.deepEqual(enriched, {
      path: "added.txt",
      summary: "added.txt (add)",
      kind: "add",
      newText: "hello from codex\n",
      diff: [
        "--- a/added.txt",
        "+++ b/added.txt",
        "@@ -0,0 +1,1 @@",
        "+hello from codex",
      ].join("\n"),
    });
  });

  it("computes an update diff for a live SDK file_change without prior commands by using the workspace baseline", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-run-state-live-update-"));
    const filePath = path.join(tempDir, "notes.txt");
    await fs.writeFile(filePath, "NEW\n", "utf8");

    const calls = await captureDebugLogsAsync(async () => {
      const state = createCodexRunState({
        workdir: tempDir,
        loadWorkspaceBaseline: async () => new Map([[filePath, "OLD\n"]]),
      });
      const enriched = await state.enrichFileChangeEvent({
        path: "notes.txt",
        summary: "notes.txt (update)",
        kind: "update",
      });

      assert.deepEqual(enriched, {
        path: "notes.txt",
        summary: "notes.txt (update)",
        kind: "update",
        oldText: "OLD\n",
        newText: "NEW\n",
        diff: [
          "--- a/notes.txt",
          "+++ b/notes.txt",
          "@@ -1,1 +1,1 @@",
          "-OLD",
          "+NEW",
        ].join("\n"),
      });
    });

    assert.equal(calls[0]?.[2]?.diffSource, "workspace_baseline");
  });

  it("computes a delete diff for a live SDK file_change without prior commands by using the workspace baseline", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-run-state-live-delete-"));
    const filePath = path.join(tempDir, "remove.txt");

    const calls = await captureDebugLogsAsync(async () => {
      const state = createCodexRunState({
        workdir: tempDir,
        loadWorkspaceBaseline: async () => new Map([[filePath, "delete me\n"]]),
      });
      const enriched = await state.enrichFileChangeEvent({
        path: "remove.txt",
        summary: "remove.txt (delete)",
        kind: "delete",
      });

      assert.deepEqual(enriched, {
        path: "remove.txt",
        summary: "remove.txt (delete)",
        kind: "delete",
        oldText: "delete me\n",
        diff: [
          "--- a/remove.txt",
          "+++ b/remove.txt",
          "@@ -1,1 +0,0 @@",
          "-delete me",
        ].join("\n"),
      });
    });

    assert.equal(calls[0]?.[2]?.diffSource, "workspace_baseline");
  });

});

/**
 * Capture console.debug calls during synchronous execution.
 * @param {() => void} fn
 * @returns {unknown[][]}
 */
function captureDebugLogs(fn) {
  /** @type {unknown[][]} */
  const calls = [];
  const originalDebug = console.debug;
  const originalLogLevel = process.env.LOG_LEVEL;
  const originalTesting = process.env.TESTING;
  console.debug = /** @type {typeof console.debug} */ ((...args) => {
    calls.push(args);
  });
  process.env.LOG_LEVEL = "debug";
  delete process.env.TESTING;

  try {
    fn();
  } finally {
    console.debug = originalDebug;
    if (originalLogLevel === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = originalLogLevel;
    }
    if (originalTesting === undefined) {
      delete process.env.TESTING;
    } else {
      process.env.TESTING = originalTesting;
    }
  }

  return calls;
}

/**
 * Capture console.debug calls during async execution.
 * @param {() => Promise<void>} fn
 * @returns {Promise<unknown[][]>}
 */
async function captureDebugLogsAsync(fn) {
  /** @type {unknown[][]} */
  const calls = [];
  const originalDebug = console.debug;
  const originalLogLevel = process.env.LOG_LEVEL;
  const originalTesting = process.env.TESTING;
  console.debug = /** @type {typeof console.debug} */ ((...args) => {
    calls.push(args);
  });
  process.env.LOG_LEVEL = "debug";
  delete process.env.TESTING;

  try {
    await fn();
  } finally {
    console.debug = originalDebug;
    if (originalLogLevel === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = originalLogLevel;
    }
    if (originalTesting === undefined) {
      delete process.env.TESTING;
    } else {
      process.env.TESTING = originalTesting;
    }
  }

  return calls;
}
