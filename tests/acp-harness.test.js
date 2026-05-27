import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAcpHarness } from "../harnesses/acp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("ACP harness", () => {
  it("runs an ACP stdio agent and emits canonical runtime events", async () => {
    const harness = createAcpHarness({
      config: {
        command: process.execPath,
        args: [path.join(__dirname, "fixtures", "acp-mock-agent.js")],
      },
    });
    const adapter = harness.createAdapter?.({
      name: "acp",
      instanceId: "test",
      continuationKey: "acp:test",
    });
    assert.ok(adapter);

    /** @type {Array<Record<string, unknown>>} */
    const events = [];
    const unsubscribe = adapter.subscribeEvents?.((event) => {
      events.push(event);
    });
    try {
      await adapter.startSession({ chatId: "chat-1" });
      const result = await adapter.sendTurn({
        chatId: "chat-1",
        input: "Run the mock",
        messages: [{ role: "user", content: [{ type: "text", text: "Run the mock" }] }],
      });

      assert.deepEqual(result.response, [{ type: "markdown", text: "Main result." }]);
      assert.equal(adapter.listSessions()[0]?.resumeCursor, "mock-session-1");
      assert.ok(events.some((event) => event.type === "plan.updated"));
      assert.ok(events.some((event) => event.type === "subagent.completed"));
      assert.ok(events.some((event) => event.type === "file-change.completed"));
      assert.ok(events.some((event) => event.type === "tool.started"));
      assert.ok(events.some((event) => event.type === "assistant.completed"));
    } finally {
      unsubscribe?.();
    }
  });

  it("forks provider sessions through the ACP session/fork RFD", async () => {
    for (const [name, kind, label] of [
      ["codex", "codex", "Codex"],
      ["claude-agent-sdk", "claude-sdk", "Claude"],
      ["pi", "pi", "Pi"],
    ]) {
      const harness = createAcpHarness({
        name,
        label,
        sessionKind: kind,
        config: {
          command: process.execPath,
          args: [path.join(__dirname, "fixtures", "acp-mock-agent.js")],
        },
      });
      /** @type {HarnessSessionRef | null} */
      let saved = null;
      /** @type {HarnessForkStackEntry[]} */
      const pushed = [];
      /** @type {string[]} */
      const replies = [];

      const handled = await harness.handleCommand({
        chatId: `${name}-chat`,
        command: "fork",
        chatInfo: {
          chat_id: `${name}-chat`,
          harness_session_kind: kind,
          harness_session_id: "mock-session-1",
        },
        context: /** @type {ExecuteActionContext} */ ({
          chatId: `${name}-chat`,
          senderIds: [],
          content: [],
          getIsAdmin: async () => true,
          send: async () => undefined,
          reply: async (event) => {
            replies.push(event.kind === "content" && typeof event.content === "string" ? event.content : JSON.stringify(event));
          },
          reactToMessage: async () => {},
          select: async () => "",
          confirm: async () => true,
        }),
        sessionForkControl: {
          getHistory: async () => [],
          save: async (_chatId, session) => {
            saved = session;
          },
          push: async (_chatId, entry) => {
            pushed.push(entry);
          },
          pop: async () => null,
        },
      });

      assert.equal(handled, true);
      assert.deepEqual(saved, { id: "mock-session-fork", kind });
      assert.deepEqual(pushed, [{ id: "mock-session-1", kind, label: `${label} ACP session` }]);
      assert.match(replies[0] ?? "", new RegExp(`Forked ${label} ACP session`));
    }
  });
});
