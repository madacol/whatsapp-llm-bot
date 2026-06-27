import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createCommandOrchestration } from "../conversation/command-orchestration.js";
import { createMessageActionContext } from "../execute-action-context.js";
import { createChannelInput } from "./helpers.js";

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
      addMessage: async () => {},
      workspaceControl: {},
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
      addMessage: async () => {},
      workspaceControl: {},
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
