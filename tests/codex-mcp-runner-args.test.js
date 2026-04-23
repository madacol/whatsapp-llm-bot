import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { startCodexAppServerRun } from "../harnesses/codex-app-server-runner.js";

describe("startCodexAppServerRun", () => {
  it("passes through extra Codex CLI args when provided", async () => {
    /** @type {Record<string, unknown> | null} */
    let openConnectionOptions = null;

    const started = await startCodexAppServerRun({
      chatId: "chat-1",
      prompt: "Continue",
      messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
      codexArgs: ["-c", "mcp_servers.demo.command=\"/usr/bin/env\""],
    }, {
      openConnection: async (options = {}) => {
        openConnectionOptions = options;
        return {
          sendRequest: async (method) => {
            if (method === "thread/start") {
              return { thread: { id: "thread-1" } };
            }
            if (method === "turn/start") {
              return { turn: { id: "turn-1" } };
            }
            return {};
          },
          notifications: (async function* () {
            yield {
              method: "turn/completed",
              params: {
                threadId: "thread-1",
                turn: {
                  id: "turn-1",
                  status: "completed",
                },
              },
            };
          })(),
          close: async () => {},
        };
      },
    });

    await started.done;

    assert.deepEqual(openConnectionOptions, {
      args: ["-c", "mcp_servers.demo.command=\"/usr/bin/env\""],
      handleRequest: openConnectionOptions?.handleRequest,
      signal: openConnectionOptions?.signal,
    });
  });
});
