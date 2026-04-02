import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSharedSkillPrompt, filterHarnessActions } from "../shared-skills.js";

describe("filterHarnessActions", () => {
  /** @type {Action[]} */
  const actions = [
    {
      name: "send_path",
      description: "Send a local path back to WhatsApp.",
      sharedSkill: {
        name: "send-path",
        description: "Return a generated file to the chat.",
        instructions: "Use this when you need to send a generated artifact back to the user.",
      },
      parameters: { type: "object", properties: {} },
      permissions: {},
      action_fn: async () => "ok",
    },
    {
      name: "restart",
      description: "Restart the bot.",
      parameters: { type: "object", properties: {} },
      permissions: {},
      action_fn: async () => "ok",
    },
  ];

  it("keeps all actions for the native harness", () => {
    assert.deepEqual(
      filterHarnessActions(actions, "native").map((action) => action.name),
      ["send_path", "restart"],
    );
  });

  it("keeps only shared-skill actions for non-native harnesses", () => {
    assert.deepEqual(
      filterHarnessActions(actions, "codex").map((action) => action.name),
      ["send_path"],
    );
    assert.deepEqual(
      filterHarnessActions(actions, "claude-agent-sdk").map((action) => action.name),
      ["send_path"],
    );
  });
});

describe("buildSharedSkillPrompt", () => {
  it("renders shared skill summaries and instructions", () => {
    const prompt = buildSharedSkillPrompt([
      {
        name: "send_path",
        description: "Send a local path back to WhatsApp.",
        sharedSkill: {
          name: "send-path",
          description: "Return a generated file to the chat.",
          instructions: "Use workspace-relative paths when possible.",
        },
        parameters: { type: "object", properties: {} },
        permissions: {},
        action_fn: async () => "ok",
      },
    ]);

    assert.equal(prompt, [
      "Shared skills available in this chat:",
      "- send-path: Return a generated file to the chat.",
      "",
      "## send-path",
      "Use workspace-relative paths when possible.",
    ].join("\n"));
  });

  it("returns an empty string when no shared skills exist", () => {
    assert.equal(buildSharedSkillPrompt([]), "");
  });
});
