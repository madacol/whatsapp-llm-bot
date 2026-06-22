import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { codexAcpEntryPoint, openFakeCodexAcpConnection } from "./codex-acp-patch-fixture.js";

/**
 * @param {AsyncIterable<Record<string, unknown>>} notifications
 * @param {(message: Record<string, unknown>) => boolean} predicate
 * @returns {Promise<Record<string, unknown>>}
 */
async function waitForNotification(notifications, predicate) {
  for await (const message of notifications) {
    if (predicate(message)) {
      return message;
    }
  }
  throw new Error("ACP connection closed before expected notification.");
}

describe("patched codex-acp stdin presentation", () => {
  it("keeps ACP fd stdio on direct reads so later client writes are consumed", async () => {
    const source = await fs.readFile(codexAcpEntryPoint, "utf8");

    assert.match(source, /function createFdJsonStream\(readFd, writeFd, onInputClosed\) \{[\s\S]*fs\.read\(readFd,/);
    assert.match(source, /const acpJsonStream = createFdJsonStream\(0, 1, handleAcpInputClosed\);/);
    assert.doesNotMatch(source, /const acpInput = fs\.createReadStream\(null, \{ fd: 0, autoClose: false \}\);/);
  });

  it("forwards Codex terminal interactions as stdin tool calls", async () => {
    const connection = await openFakeCodexAcpConnection();

    try {
      await connection.sendRequest("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "madabot-test", version: "0" },
        clientCapabilities: {},
      });

      const session = /** @type {{ sessionId?: string }} */ (await connection.sendRequest("session/new", { cwd: process.cwd(), mcpServers: [] }));
      assert.equal(session?.sessionId, "fake-thread-1");

      const stdinUpdate = waitForNotification(connection.notifications, (message) => {
        if (message.method !== "session/update") {
          return false;
        }
        const params = /** @type {{ update?: Record<string, unknown> }} */ (message.params);
        return params.update?.sessionUpdate === "tool_call"
          && params.update?.title === "stdin";
      });

      const promptResult = /** @type {{ stopReason?: string }} */ (await connection.sendRequest("session/prompt", {
        sessionId: "fake-thread-1",
        prompt: [{ type: "text", text: "stdin" }],
      }));
      assert.equal(promptResult?.stopReason, "end_turn");

      const notification = await stdinUpdate;
      assert.deepEqual(notification.params, {
        sessionId: "fake-thread-1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "terminal-interaction:stdin-command-1",
          kind: "other",
          title: "stdin",
          status: "completed",
          rawInput: {
            stdin: "yes\n",
            payload: {
              threadId: "fake-thread-1",
              turnId: "fake-turn-1",
              itemId: "stdin-command-1",
              processId: "65440",
              stdin: "yes\n",
            },
            itemId: "stdin-command-1",
          },
        },
      });
    } finally {
      await connection.close();
    }
  });
});
