import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { openFakeCodexAcpConnection } from "./codex-acp-patch-fixture.js";

describe("patched codex-acp web search tool calls", () => {
  it("emits ACP thought chunks for live Codex reasoning notifications", async () => {
    const connection = await openFakeCodexAcpConnection();

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
          const thoughtUpdates = notifications
            .map((entry) => /** @type {{ params?: { update?: { sessionUpdate?: string } } }} */ (entry).params?.update)
            .filter((update) => update?.sessionUpdate === "agent_thought_chunk");
          if (thoughtUpdates.length >= 2) {
            return;
          }
        }
      })();

      const result = /** @type {{ stopReason?: string }} */ (await connection.sendRequest("session/prompt", {
        sessionId: "fake-thread-1",
        prompt: [{ type: "text", text: "reasoning" }],
      }));
      assert.equal(result?.stopReason, "end_turn");

      await Promise.race([
        collectNotifications,
        delay(500).then(() => {
          throw new Error(`Timed out waiting for reasoning ACP updates: ${JSON.stringify(notifications)}`);
        }),
      ]);

      const thoughtUpdates = notifications
        .map((entry) => /** @type {{ params?: { update?: Record<string, unknown> } }} */ (entry).params?.update)
        .filter((update) => update?.sessionUpdate === "agent_thought_chunk");

      assert.deepEqual(thoughtUpdates, [
        {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "Thinking..." },
        },
        {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "Checking restart status." },
        },
      ]);
    } finally {
      await connection.close();
    }
  });

  it("emits a thinking placeholder for live Codex reasoning item lifecycles", async () => {
    const connection = await openFakeCodexAcpConnection();

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
          const thoughtUpdate = /** @type {{ params?: { update?: { sessionUpdate?: string } } }} */ (notification).params?.update;
          if (thoughtUpdate?.sessionUpdate === "agent_thought_chunk") {
            return;
          }
        }
      })();

      const result = /** @type {{ stopReason?: string }} */ (await connection.sendRequest("session/prompt", {
        sessionId: "fake-thread-1",
        prompt: [{ type: "text", text: "empty-reasoning" }],
      }));
      assert.equal(result?.stopReason, "end_turn");

      await Promise.race([
        collectNotifications,
        delay(500).then(() => {
          throw new Error(`Timed out waiting for reasoning lifecycle ACP update: ${JSON.stringify(notifications)}`);
        }),
      ]);

      const thoughtUpdates = notifications
        .map((entry) => /** @type {{ params?: { update?: Record<string, unknown> } }} */ (entry).params?.update)
        .filter((update) => update?.sessionUpdate === "agent_thought_chunk");

      assert.deepEqual(thoughtUpdates, [{
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Thinking..." },
      }]);
    } finally {
      await connection.close();
    }
  });

  it("requests Codex reasoning summaries for API-key sessions when the model supports reasoning", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-acp-reasoning-summary-"));
    const recordPath = path.join(tempDir, "events.jsonl");
    const connection = await openFakeCodexAcpConnection({
      FAKE_CODEX_ACCOUNT_TYPE: "apiKey",
      FAKE_CODEX_REASONING_EFFORT: "high",
      FAKE_CODEX_RECORD_PATH: recordPath,
    });

    try {
      await connection.sendRequest("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "madabot-test", version: "0" },
        clientCapabilities: {},
      });
      const session = /** @type {{ sessionId?: string }} */ (await connection.sendRequest("session/new", { cwd: process.cwd(), mcpServers: [] }));
      assert.equal(session?.sessionId, "fake-thread-1");

      const result = /** @type {{ stopReason?: string }} */ (await connection.sendRequest("session/prompt", {
        sessionId: "fake-thread-1",
        prompt: [{ type: "text", text: "empty-reasoning" }],
      }));
      assert.equal(result?.stopReason, "end_turn");

      const records = (await fs.readFile(recordPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const turnStart = records.find((record) => record.event === "turn/start");
      assert.equal(turnStart?.value.summary, "auto");
    } finally {
      await connection.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("emits ACP tool calls for live Codex webSearch items", async () => {
    const connection = await openFakeCodexAcpConnection();

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
});
