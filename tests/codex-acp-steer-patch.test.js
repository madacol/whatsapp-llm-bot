import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { openAcpConnection } from "../harnesses/acp-client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const codexAcpEntryPoint = path.join(__dirname, "..", "node_modules", "@agentclientprotocol", "codex-acp", "dist", "index.js");

describe("patched codex-acp steering", () => {
  it("exposes fast mode config and sends the Codex fast service tier", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-acp-fast-"));
    const recordPath = path.join(tempDir, "events.jsonl");
    const fakeCodexPath = path.join(__dirname, "fixtures", "fake-codex-app-server.js");
    await fs.chmod(fakeCodexPath, 0o755);

    const connection = await openAcpConnection({
      command: process.execPath,
      args: [codexAcpEntryPoint],
      env: {
        ...process.env,
        CODEX_PATH: fakeCodexPath,
        FAKE_CODEX_RECORD_PATH: recordPath,
      },
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

  it("emits ACP tool calls for live Codex webSearch items", async () => {
    const fakeCodexPath = path.join(__dirname, "fixtures", "fake-codex-app-server.js");
    await fs.chmod(fakeCodexPath, 0o755);

    const connection = await openAcpConnection({
      command: process.execPath,
      args: [codexAcpEntryPoint],
      env: {
        ...process.env,
        CODEX_PATH: fakeCodexPath,
      },
    });

    try {
      await connection.sendRequest("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "madabot-test", version: "0" },
        clientCapabilities: {},
      });
      const session = /** @type {{ sessionId?: string }} */ (await connection.sendRequest("session/new", { cwd: process.cwd(), mcpServers: [] }));
      assert.equal(session?.sessionId, "fake-thread-1");

      /** @type {Record<string, unknown>[]} */
      const notifications = [];
      const collectNotifications = (async () => {
        for await (const notification of connection.notifications) {
          notifications.push(notification);
          const updates = notifications
            .map((entry) => /** @type {{ params?: { update?: { sessionUpdate?: string, toolCallId?: string } } }} */ (entry).params?.update)
            .filter((update) => update?.toolCallId === "web-search-1");
          if (updates.some((update) => update?.sessionUpdate === "tool_call")
            && updates.some((update) => update?.sessionUpdate === "tool_call_update")) {
            return;
          }
        }
      })();

      const result = /** @type {{ stopReason?: string }} */ (await connection.sendRequest("session/prompt", {
        sessionId: "fake-thread-1",
        prompt: [{ type: "text", text: "web" }],
      }));
      assert.equal(result?.stopReason, "end_turn");

      await Promise.race([
        collectNotifications,
        delay(500).then(() => {
          throw new Error(`Timed out waiting for webSearch ACP updates: ${JSON.stringify(notifications)}`);
        }),
      ]);

      const webUpdates = notifications
        .map((entry) => /** @type {{ params?: { update?: Record<string, unknown> } }} */ (entry).params?.update)
        .filter((update) => update?.toolCallId === "web-search-1");

      assert.deepEqual(webUpdates, [
        {
          sessionUpdate: "tool_call",
          toolCallId: "web-search-1",
          kind: "search",
          title: "Web search: runtime migration",
          status: "in_progress",
          rawInput: {
            query: "runtime migration",
            action: {
              type: "search",
              query: "runtime migration",
              queries: ["runtime migration"],
            },
          },
        },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "web-search-1",
          status: "completed",
          rawInput: {
            query: "runtime migration",
            action: {
              type: "search",
              query: "runtime migration",
              queries: ["runtime migration"],
            },
          },
        },
      ]);
    } finally {
      await connection.close();
    }
  });

  it("advertises ACP steer and forwards session/steer to the active Codex turn", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-acp-steer-"));
    const recordPath = path.join(tempDir, "events.jsonl");
    const fakeCodexPath = path.join(__dirname, "fixtures", "fake-codex-app-server.js");
    await fs.chmod(fakeCodexPath, 0o755);

    const connection = await openAcpConnection({
      command: process.execPath,
      args: [codexAcpEntryPoint],
      env: {
        ...process.env,
        CODEX_PATH: fakeCodexPath,
        FAKE_CODEX_RECORD_PATH: recordPath,
      },
    });

    try {
      const initialized = /** @type {{ agentCapabilities?: { sessionCapabilities?: unknown } }} */ (await connection.sendRequest("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "madabot-test", version: "0" },
        clientCapabilities: {},
      }));
      assert.deepEqual(
        initialized?.agentCapabilities?.sessionCapabilities,
        { resume: {}, list: {}, steer: {} },
      );

      const session = /** @type {{ sessionId?: string }} */ (await connection.sendRequest("session/new", { cwd: process.cwd(), mcpServers: [] }));
      assert.equal(session?.sessionId, "fake-thread-1");

      const prompt = connection.sendRequest("session/prompt", {
        sessionId: "fake-thread-1",
        prompt: [{ type: "text", text: "first" }],
      });

      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          await connection.sendRequest("session/steer", {
            sessionId: "fake-thread-1",
            text: "follow up",
          });
          break;
        } catch (error) {
          if (attempt === 19) {
            throw error;
          }
          await delay(10);
        }
      }

      const promptResult = /** @type {{ stopReason?: string }} */ (await prompt);
      assert.equal(promptResult?.stopReason, "end_turn");

      const records = (await fs.readFile(recordPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const steerRecords = records.filter((record) => record.event === "turn/steer");
      assert.deepEqual(steerRecords, [{
        event: "turn/steer",
        value: {
          threadId: "fake-thread-1",
          input: [{ type: "text", text: "follow up" }],
          expectedTurnId: "fake-turn-1",
        },
      }]);
    } finally {
      await connection.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
