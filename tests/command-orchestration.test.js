import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createCommandOrchestration } from "../conversation/command-orchestration.js";
import { createMessageActionContext } from "../execute-action-context.js";
import { createChannelInput } from "./helpers.js";

/**
 * @typedef {Pick<ReturnType<typeof import("../conversation/agent-runtime.js").createAgentRuntime>,
 *   "cancelActiveRun" | "clearActiveSession" | "resolveSelection" | "resolveWorkdir" | "handleCommand"
 * >} TestAgentRuntime
 */

/**
 * @param {Partial<TestAgentRuntime>} [overrides]
 * @returns {TestAgentRuntime}
 */
function createAgentRuntime(overrides = {}) {
  return {
    cancelActiveRun: async () => false,
    clearActiveSession: async () => false,
    resolveSelection: async () => ({
      persona: null,
      selectedRuntimeName: "codex",
      runtimeName: "codex",
      instanceId: null,
      config: null,
      ownerKey: "codex",
    }),
    resolveWorkdir: () => undefined,
    handleCommand: async () => false,
    ...overrides,
  };
}

/**
 * @returns {import("../store.js").Store["addMessage"]}
 */
function createAddMessage() {
  return async (chatId, messageData, senderIds = null, displayKey = null) => ({
    message_id: 1,
    chat_id: chatId,
    sender_id: senderIds?.[0] ?? "",
    message_data: messageData,
    timestamp: new Date(0),
    display_key: displayKey,
  });
}

/**
 * @returns {import("../workspace-command-router.js").WorkspaceControl}
 */
function createWorkspaceControl() {
  return {
    list: async () => {
      throw new Error("workspace list should not run");
    },
    createWorkspace: async () => {
      throw new Error("workspace create should not run");
    },
    status: async () => {
      throw new Error("workspace status should not run");
    },
    diff: async () => {
      throw new Error("workspace diff should not run");
    },
    archiveByName: async () => {
      throw new Error("workspace archive-by-name should not run");
    },
    archiveCurrent: async () => {
      throw new Error("workspace archive-current should not run");
    },
  };
}

describe("Command Orchestration", () => {
  it("owns slash diff workdir errors and reports the command as handled", async () => {
    const { context: turn, responses } = createChannelInput({
      content: [{ type: "text", text: "/diff" }],
    });
    const agentRuntime = createAgentRuntime({
      handleCommand: async () => {
        throw new Error("runtime command should not run");
      },
    });
    const commands = createCommandOrchestration({
      addMessage: createAddMessage(),
      workspaceControl: createWorkspaceControl(),
      agentRuntime,
    });

    const result = await commands.handleCommand({
      route: { type: "slash-command" },
      turn,
      chatInfo: undefined,
      context: createMessageActionContext(turn),
      resolvedBinding: { kind: "unbound" },
    });

    assert.deepEqual(result, { kind: "handled", followUpTurn: null });
    assert.ok(responses.some((response) => response.text.includes("Could not resolve a workdir for `/diff`.")));
  });

  it("returns unhandled when Agent Runtime declines a slash command", async () => {
    const { context: turn } = createChannelInput({
      content: [{ type: "text", text: "/unknown" }],
    });
    let handledCommand = "";
    const commands = createCommandOrchestration({
      addMessage: createAddMessage(),
      workspaceControl: createWorkspaceControl(),
      agentRuntime: createAgentRuntime({
        handleCommand: async ({ command }) => {
          handledCommand = command;
          return false;
        },
      }),
    });

    const result = await commands.handleCommand({
      route: { type: "slash-command" },
      turn,
      chatInfo: undefined,
      context: createMessageActionContext(turn),
      resolvedBinding: { kind: "unbound" },
    });

    assert.deepEqual(result, { kind: "unhandled" });
    assert.equal(handledCommand, "unknown");
  });
});
