import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openFakeCodexAcpConnection } from "./codex-acp-patch-fixture.js";

describe("patched codex-acp fast mode", () => {
  it("persists fast mode in Codex settings and applies the Codex service tier per turn", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-acp-fast-"));
    const recordPath = path.join(tempDir, "events.jsonl");
    const connection = await openFakeCodexAcpConnection({
      FAKE_CODEX_RECORD_PATH: recordPath,
    });

    try {
      await connection.sendRequest("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "madabot-test", version: "0" },
        clientCapabilities: {},
      });

      const session = /** @type {{ sessionId?: string, configOptions?: Record<string, unknown>[] }} */ (
        await connection.sendRequest("session/new", { cwd: process.cwd(), mcpServers: [] })
      );
      assert.equal(session?.sessionId, "fake-thread-1");
      const fastOption = session.configOptions?.find((option) => option.id === "fast_mode");
      assert.deepEqual(fastOption, {
        type: "boolean",
        id: "fast_mode",
        name: "Fast mode",
        description: "Use the Codex fast service tier for subsequent turns.",
        category: "model_config",
        currentValue: false,
      });

      const updated = /** @type {{ configOptions?: Record<string, unknown>[] }} */ (await connection.sendRequest("session/set_config_option", {
        sessionId: "fake-thread-1",
        configId: "fast_mode",
        type: "boolean",
        value: true,
      }));
      assert.equal(updated.configOptions?.find((option) => option.id === "fast_mode")?.currentValue, true);

      const promptResult = /** @type {{ stopReason?: string }} */ (await connection.sendRequest("session/prompt", {
        sessionId: "fake-thread-1",
        prompt: [{ type: "text", text: "web" }],
      }));
      assert.equal(promptResult?.stopReason, "end_turn");

      const records = (await fs.readFile(recordPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.ok(records.some((record) => record.event === "thread/settings/update"
        && record.value.threadId === "fake-thread-1"
        && record.value.serviceTier === "fast"), JSON.stringify(records));
      assert.ok(records.some((record) => record.event === "turn/start"
        && record.value.threadId === "fake-thread-1"
        && record.value.serviceTier === "fast"), JSON.stringify(records));
    } finally {
      await connection.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("surfaces a clear per-turn error when the Codex app server rejects fast service tier", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-acp-fast-reject-"));
    const recordPath = path.join(tempDir, "events.jsonl");
    const connection = await openFakeCodexAcpConnection({
      FAKE_CODEX_RECORD_PATH: recordPath,
      FAKE_CODEX_REJECT_FAST: "1",
    });

    try {
      await connection.sendRequest("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "madabot-test", version: "0" },
        clientCapabilities: {},
      });
      await connection.sendRequest("session/new", { cwd: process.cwd(), mcpServers: [] });
      await connection.sendRequest("session/set_config_option", {
        sessionId: "fake-thread-1",
        configId: "fast_mode",
        type: "boolean",
        value: true,
      });

      await assert.rejects(
        connection.sendRequest("session/prompt", {
          sessionId: "fake-thread-1",
          prompt: [{ type: "text", text: "web" }],
        }),
        /Codex fast mode failed: .*fast service tier unavailable/,
      );

      const records = (await fs.readFile(recordPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const turnStarts = records.filter((record) => record.event === "turn/start");
      assert.equal(turnStarts[0]?.value.serviceTier, "fast");
      assert.ok(records.some((record) => record.event === "thread/settings/update"
        && record.value.threadId === "fake-thread-1"
        && record.value.serviceTier === "fast"), JSON.stringify(records));
    } finally {
      await connection.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps fast mode enabled when the app server lacks fast settings persistence", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-acp-fast-settings-unsupported-"));
    const recordPath = path.join(tempDir, "events.jsonl");
    const connection = await openFakeCodexAcpConnection({
      FAKE_CODEX_RECORD_PATH: recordPath,
      FAKE_CODEX_REJECT_SETTINGS_UPDATE: "unknown",
    });

    try {
      await connection.sendRequest("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "madabot-test", version: "0" },
        clientCapabilities: {},
      });
      await connection.sendRequest("session/new", { cwd: process.cwd(), mcpServers: [] });
      const updated = /** @type {{ configOptions?: Record<string, unknown>[] }} */ (await connection.sendRequest("session/set_config_option", {
        sessionId: "fake-thread-1",
        configId: "fast_mode",
        type: "boolean",
        value: true,
      }));
      assert.equal(updated.configOptions?.find((option) => option.id === "fast_mode")?.currentValue, true);

      const promptResult = /** @type {{ stopReason?: string }} */ (await connection.sendRequest("session/prompt", {
        sessionId: "fake-thread-1",
        prompt: [{ type: "text", text: "web" }],
      }));
      assert.equal(promptResult?.stopReason, "end_turn");

      const records = (await fs.readFile(recordPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.ok(records.some((record) => record.event === "thread/settings/update"
        && record.value.threadId === "fake-thread-1"
        && record.value.serviceTier === "fast"), JSON.stringify(records));
      assert.ok(records.some((record) => record.event === "turn/start"
        && record.value.threadId === "fake-thread-1"
        && record.value.serviceTier === "fast"), JSON.stringify(records));
    } finally {
      await connection.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
