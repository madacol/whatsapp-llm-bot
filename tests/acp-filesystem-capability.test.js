import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAcpFilesystemCapability } from "../harnesses/acp-filesystem-capability.js";

describe("ACP filesystem capability", () => {
  it("writes files and emits ACP file-change events", async () => {
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-fs-capability-"));
    const filePath = path.join(workdir, "src/app.js");
    /** @type {import("../harnesses/harness-runtime-events.js").HarnessRuntimeEvent[]} */
    const events = [];
    const filesystem = createAcpFilesystemCapability({
      runConfig: { workdir },
      hooks: { onAskUser: async () => "Allow once" },
      emitRuntimeEvent: async (event) => {
        events.push(event);
      },
    });

    await filesystem.writeTextFile({ params: { path: filePath, content: "export const value = 1;\n" } });

    assert.equal(await fs.readFile(filePath, "utf8"), "export const value = 1;\n");
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, "file-change.completed");
    assert.equal(events[0]?.type === "file-change.completed" ? events[0].change.kind : null, "add");
    assert.equal(events[0]?.type === "file-change.completed" ? events[0].change.source : null, "tool");
  });

  it("rejects protected file writes before mutating the file", async () => {
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-fs-protected-"));
    const filePath = path.join(workdir, "package.json");
    await fs.writeFile(filePath, "{\"name\":\"before\"}\n", "utf8");
    const filesystem = createAcpFilesystemCapability({
      runConfig: { workdir, protectedPaths: ["package.json"] },
      hooks: { onAskUser: async () => "Deny" },
      emitRuntimeEvent: async () => {},
    });

    await assert.rejects(
      filesystem.writeTextFile({ params: { path: filePath, content: "{\"name\":\"after\"}\n" } }),
      /User denied protected path change/,
    );
    assert.equal(await fs.readFile(filePath, "utf8"), "{\"name\":\"before\"}\n");
  });

  it("asks before filesystem sandbox escapes", async () => {
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-fs-sandbox-"));
    const outsidePath = path.join(os.tmpdir(), `acp-fs-outside-${Date.now()}.txt`);
    /** @type {string[]} */
    const prompts = [];
    const filesystem = createAcpFilesystemCapability({
      runConfig: { workdir, sandboxMode: "workspace-write" },
      hooks: {
        onAskUser: async (question) => {
          prompts.push(question);
          return "❌ Deny";
        },
      },
      emitRuntimeEvent: async () => {},
    });

    await assert.rejects(
      filesystem.writeTextFile({ params: { path: outsidePath, content: "outside\n" } }),
      /User denied sandbox escape/,
    );
    assert.match(prompts[0] ?? "", /Sandbox escape request/);
    await assert.rejects(fs.stat(outsidePath), /ENOENT/);
  });
});
