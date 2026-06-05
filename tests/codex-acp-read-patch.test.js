import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { openFakeCodexAcpConnection } from "./codex-acp-patch-fixture.js";

describe("patched codex-acp read tool calls", () => {
  it("preserves Codex read command actions and line ranges in ACP read tool calls", async () => {
    const connection = await openFakeCodexAcpConnection();

    try {
      await connection.sendRequest("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "madabot-test", version: "0" },
        clientCapabilities: {},
      });
      const cwd = process.cwd();
      const readPath = path.join(cwd, "sample-lines.txt");
      const session = /** @type {{ sessionId?: string }} */ (await connection.sendRequest("session/new", { cwd, mcpServers: [] }));
      assert.equal(session?.sessionId, "fake-thread-1");

      /** @type {Record<string, unknown>[]} */
      const notifications = [];
      const collectNotifications = (async () => {
        for await (const notification of connection.notifications) {
          notifications.push(notification);
          const update = /** @type {{ params?: { update?: { sessionUpdate?: string, toolCallId?: string } } }} */ (notification).params?.update;
          if (update?.toolCallId === "read-1" && update.sessionUpdate === "tool_call") {
            return;
          }
        }
      })();

      const result = /** @type {{ stopReason?: string }} */ (await connection.sendRequest("session/prompt", {
        sessionId: "fake-thread-1",
        prompt: [{ type: "text", text: "read" }],
      }));
      assert.equal(result?.stopReason, "end_turn");

      await Promise.race([
        collectNotifications,
        delay(500).then(() => {
          throw new Error(`Timed out waiting for read ACP update: ${JSON.stringify(notifications)}`);
        }),
      ]);

      const readUpdate = notifications
        .map((entry) => /** @type {{ params?: { update?: Record<string, unknown> } }} */ (entry).params?.update)
        .find((update) => update?.toolCallId === "read-1" && update.sessionUpdate === "tool_call");

      assert.deepEqual(readUpdate, {
        sessionUpdate: "tool_call",
        toolCallId: "read-1",
        kind: "read",
        title: "Read sample-lines.txt",
        status: "in_progress",
        locations: [{ path: readPath, line: 10 }],
        rawInput: {
          commandAction: {
            type: "read",
            command: "sed -n '10,12p' sample-lines.txt",
            name: "sample-lines.txt",
            path: readPath,
          },
        },
        _meta: {
          codex: {
            lineRange: { start: 10, end: 12 },
          },
        },
      });
    } finally {
      await connection.close();
    }
  });
});
