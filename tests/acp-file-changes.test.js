import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  emitAcpSnapshotFileChanges,
  isAcpFileChangeIgnored,
  reconcileAcpFileChangeWithBaseline,
  resolveAcpFileChangePath,
} from "../harnesses/acp-file-changes.js";

describe("ACP file changes", () => {
  it("resolves provider paths against the run workdir", () => {
    assert.equal(resolveAcpFileChangePath("/tmp/acp-work", "src/file.js"), "/tmp/acp-work/src/file.js");
  });

  it("corrects provider adds for files present in the run-start baseline", () => {
    const workdir = "/tmp/acp-work";
    const filePath = "/tmp/acp-work/src/existing.js";
    const before = new Map([[filePath, "export const value = 1;\n"]]);
    const event = /** @type {import("../harnesses/harness-runtime-events.js").HarnessRuntimeEvent} */ ({
      type: "file-change.completed",
      provider: "acp",
      change: {
        path: filePath,
        summary: "Edit existing.js",
        kind: "add",
        newText: "export const value = 2;\n",
      },
    });

    const reconciled = reconcileAcpFileChangeWithBaseline(event, before, workdir);

    assert.equal(reconciled.type, "file-change.completed");
    assert.equal(reconciled.change.kind, "update");
    assert.equal(reconciled.change.oldText, "export const value = 1;\n");
    assert.equal(reconciled.change.newText, "export const value = 2;\n");
    assert.match(String(reconciled.change.diff ?? ""), /-export const value = 1;/);
    assert.match(String(reconciled.change.diff ?? ""), /\+export const value = 2;/);
  });

  it("adds unified diffs when providers send old and new text without a diff", () => {
    const workdir = "/tmp/acp-work";
    const filePath = "/tmp/acp-work/src/existing.js";
    const before = new Map([[filePath, "export const value = 1;\n"]]);
    const event = /** @type {import("../harnesses/harness-runtime-events.js").HarnessRuntimeEvent} */ ({
      type: "file-change.completed",
      provider: "acp",
      change: {
        path: filePath,
        summary: "Edit existing.js",
        kind: "update",
        oldText: "export const value = 1;\n",
        newText: "export const value = 2;\n",
      },
    });

    const reconciled = reconcileAcpFileChangeWithBaseline(event, before, workdir);

    assert.equal(reconciled.type, "file-change.completed");
    assert.equal(reconciled.change.kind, "update");
    assert.match(String(reconciled.change.diff ?? ""), /-export const value = 1;/);
    assert.match(String(reconciled.change.diff ?? ""), /\+export const value = 2;/);
  });

  it("emits snapshot adds, updates, and deletes without duplicating provider-emitted paths", async () => {
    const skippedPath = "/tmp/acp-work/skipped.js";
    const updatedPath = "/tmp/acp-work/updated.js";
    const deletedPath = "/tmp/acp-work/deleted.js";
    const addedPath = "/tmp/acp-work/added.js";
    const before = new Map([
      [skippedPath, "old skipped\n"],
      [updatedPath, "old updated\n"],
      [deletedPath, "delete me\n"],
    ]);
    const after = new Map([
      [skippedPath, "new skipped\n"],
      [updatedPath, "new updated\n"],
      [addedPath, "new file\n"],
    ]);
    /** @type {import("../harnesses/harness-runtime-events.js").HarnessRuntimeEvent[]} */
    const events = [];

    await emitAcpSnapshotFileChanges({
      before,
      after,
      emittedPaths: new Set([skippedPath]),
      emitRuntimeEvent: async (event) => {
        events.push(event);
      },
    });

    const changes = events
      .filter((event) => event.type === "file-change.completed")
      .map((event) => event.change);
    assert.deepEqual(changes.map((change) => [change.path, change.kind]), [
      [updatedPath, "update"],
      [addedPath, "add"],
      [deletedPath, "delete"],
    ]);
    assert.ok(changes.every((change) => typeof change.diff === "string"));
  });

  it("detects ignored ACP file changes from runtime-state path patterns", async () => {
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-ignore-"));

    assert.equal(
      isAcpFileChangeIgnored(
        { workdir, ignoredFileChangePaths: ["auth_info_baileys/**"] },
        path.join(workdir, "auth_info_baileys/sender-key-test.json"),
      ),
      true,
    );
    assert.equal(
      isAcpFileChangeIgnored({ workdir, ignoredFileChangePaths: ["auth_info_baileys/**"] }, path.join(workdir, "src/app.js")),
      false,
    );
  });
});
