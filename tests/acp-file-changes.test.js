import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  collectAcpSnapshotFileChanges,
  collectAcpTargetedFileChanges,
  emitAcpSnapshotFileChanges,
  isAcpFileChangeIgnored,
  reconcileAcpFileChangeWithBaseline,
  resolveAcpFileChangePath,
  snapshotAcpPaths,
  snapshotAcpWorkdir,
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

  it("classifies provider empty-text edits as deletes when the file is missing", async () => {
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-delete-"));
    const filePath = path.join(workdir, "TODO.md");
    const oldText = "# TODO\n\n- Remove the obsolete action system.\n";
    const before = new Map([[filePath, oldText]]);
    const event = /** @type {import("../harnesses/harness-runtime-events.js").HarnessRuntimeEvent} */ ({
      type: "file-change.completed",
      provider: "acp",
      change: {
        path: filePath,
        summary: "Editing files",
        kind: "update",
        oldText,
        newText: "",
      },
    });

    const reconciled = reconcileAcpFileChangeWithBaseline(event, before, workdir);

    assert.equal(reconciled.type, "file-change.completed");
    assert.equal(reconciled.change.kind, "delete");
    assert.equal(reconciled.change.oldText, oldText);
    assert.equal(reconciled.change.newText, undefined);
    assert.match(String(reconciled.change.diff ?? ""), /--- a\//);
    assert.match(String(reconciled.change.diff ?? ""), /\+\+\+ \/dev\/null/);
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
    assert.deepEqual(changes.map((change) => change.source), ["snapshot", "snapshot", "snapshot"]);
    assert.ok(changes.every((change) => change.diff === undefined));
    assert.deepEqual(changes.map((change) => [change.oldText, change.newText]), [
      ["old updated\n", "new updated\n"],
      [undefined, "new file\n"],
      ["delete me\n", undefined],
    ]);
  });

  it("collects large snapshot batches as semantic file-change events", () => {
    const before = new Map();
    const after = new Map(
      Array.from({ length: 26 }, (_entry, index) => [
        `/tmp/acp-work/generated-${index}.txt`,
        `generated ${index}\n`,
      ]),
    );

    const changes = collectAcpSnapshotFileChanges({
      before,
      after,
      emittedPaths: new Set(),
    });

    assert.equal(changes.length, 26);
    assert.ok(changes.every((event) => event.type === "file-change.completed"));
    assert.ok(changes.every((event) => event.change.source === "snapshot"));
  });

  it("snapshots and diffs explicit paths outside the run workdir", async () => {
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-target-workdir-"));
    const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "acp-target-external-"));
    const updatedPath = path.join(externalRoot, "skill.md");
    const addedPath = path.join(externalRoot, "new.md");
    const deletedPath = path.join(externalRoot, "old.md");

    await fs.writeFile(updatedPath, "old skill\n", "utf8");
    await fs.writeFile(deletedPath, "delete me\n", "utf8");
    const before = await snapshotAcpPaths(workdir, [updatedPath, addedPath, deletedPath]);
    await fs.writeFile(updatedPath, "new skill\n", "utf8");
    await fs.writeFile(addedPath, "new file\n", "utf8");
    await fs.rm(deletedPath);
    const after = await snapshotAcpPaths(workdir, [updatedPath, addedPath, deletedPath]);

    const changes = collectAcpTargetedFileChanges({
      before,
      after,
      emittedPaths: new Set(),
      summary: "apply_patch",
      raw: { source: "test" },
    });

    assert.deepEqual(changes.map((event) => [event.change.path, event.change.kind]), [
      [updatedPath, "update"],
      [addedPath, "add"],
      [deletedPath, "delete"],
    ]);
    assert.deepEqual(changes.map((event) => [event.change.oldText, event.change.newText]), [
      ["old skill\n", "new skill\n"],
      [undefined, "new file\n"],
      ["delete me\n", undefined],
    ]);
    assert.match(String(changes[0].change.diff ?? ""), /-old skill/);
    assert.match(String(changes[0].change.diff ?? ""), /\+new skill/);
  });

  it("detects ignored ACP file changes only from explicit path policies", async () => {
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
    assert.equal(
      isAcpFileChangeIgnored({ workdir }, path.join(workdir, "logs/raw-events.2026-06-04T14Z.ndjson")),
      false,
    );
    assert.equal(
      isAcpFileChangeIgnored({ workdir }, path.join(workdir, "pgdata/root.sqlite")),
      false,
    );
  });

  it("excludes logs from ACP workdir snapshots", async () => {
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-snapshot-ignore-"));
    await fs.mkdir(path.join(workdir, "logs"), { recursive: true });
    await fs.writeFile(path.join(workdir, "logs/raw-events.2026-06-04T14Z.ndjson"), "{}\n", "utf8");
    await fs.mkdir(path.join(workdir, ".git", "objects"), { recursive: true });
    await fs.writeFile(path.join(workdir, ".git", "objects", "ignored"), "git object\n", "utf8");
    await fs.mkdir(path.join(workdir, "project", ".venv", "lib"), { recursive: true });
    await fs.writeFile(path.join(workdir, "project", ".venv", "lib", "site.py"), "ignored = True\n", "utf8");
    await fs.mkdir(path.join(workdir, "project", "__pycache__"), { recursive: true });
    await fs.writeFile(path.join(workdir, "project", "__pycache__", "app.pyc"), "ignored\n", "utf8");
    await fs.mkdir(path.join(workdir, "src"), { recursive: true });
    await fs.writeFile(path.join(workdir, "src/app.js"), "export const value = 1;\n", "utf8");

    const snapshot = await snapshotAcpWorkdir(workdir);

    assert.ok(snapshot);
    assert.equal(snapshot.has(path.join(workdir, "logs/raw-events.2026-06-04T14Z.ndjson")), false);
    assert.equal(snapshot.has(path.join(workdir, ".git", "objects", "ignored")), false);
    assert.equal(snapshot.has(path.join(workdir, "project", ".venv", "lib", "site.py")), false);
    assert.equal(snapshot.has(path.join(workdir, "project", "__pycache__", "app.pyc")), false);
    assert.equal(snapshot.has(path.join(workdir, "src/app.js")), true);
  });

  it("uses workspace-local snapshot-ignore patterns during ACP workdir snapshots", async () => {
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-workspace-snapshot-ignore-"));
    await fs.writeFile(path.join(workdir, "snapshot-ignore.txt"), "mounted-voice-assistant/**\n", "utf8");
    await fs.mkdir(path.join(workdir, "mounted-voice-assistant", "docs"), { recursive: true });
    await fs.writeFile(path.join(workdir, "mounted-voice-assistant", "docs", "requirements.md"), "# Slow mount\n", "utf8");
    await fs.mkdir(path.join(workdir, "docs"), { recursive: true });
    await fs.writeFile(path.join(workdir, "docs", "requirements.md"), "# Local docs\n", "utf8");

    const snapshot = await snapshotAcpWorkdir(workdir);

    assert.ok(snapshot);
    assert.equal(snapshot.has(path.join(workdir, "mounted-voice-assistant", "docs", "requirements.md")), false);
    assert.equal(snapshot.has(path.join(workdir, "docs", "requirements.md")), true);
    assert.equal(snapshot.has(path.join(workdir, "snapshot-ignore.txt")), true);
    assert.equal(
      isAcpFileChangeIgnored(
        { workdir },
        path.join(workdir, "mounted-voice-assistant", "docs", "requirements.md"),
      ),
      false,
    );
  });
});
