import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { openFakeCodexAcpConnection } from "./codex-acp-patch-fixture.js";

describe("patched codex-acp web search tool calls", () => {
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
