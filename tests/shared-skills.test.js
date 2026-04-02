import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSharedSkillMarkdownDocument,
  buildSharedSkillPrompt,
  filterHarnessActions,
  getSharedSkillViews,
} from "../shared-skills.js";
import generateImage from "../actions/tools/generateImage/index.js";
import generateVideo from "../actions/tools/generateVideo/index.js";
import sendPath from "../actions/tools/sendPath/index.js";

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
      "To invoke a shared skill, respond with exactly one fenced `madabot-skill` JSON block and no extra text.",
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

describe("getSharedSkillViews", () => {
  it("normalizes shared skill metadata for downstream renderers", () => {
    const [skill] = getSharedSkillViews([
      {
        name: "send_path",
        description: "Send a local path back to WhatsApp.",
        sharedSkill: {
          name: "send-path",
          instructions: "  Use workspace-relative paths when possible.  ",
        },
        parameters: { type: "object", properties: {} },
        permissions: {},
        action_fn: async () => "ok",
      },
    ]);

    assert.deepEqual(skill, {
      actionName: "send_path",
      name: "send-path",
      description: "Send a local path back to WhatsApp.",
      instructions: "Use workspace-relative paths when possible.",
    });
  });
});

describe("buildSharedSkillMarkdownDocument", () => {
  it("renders Claude skill markdown from the shared normalized view", () => {
    const [skill] = getSharedSkillViews([
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

    assert.equal(
      buildSharedSkillMarkdownDocument(skill),
      [
        "---",
        "name: send-path",
        "description: Return a generated file to the chat.",
        "---",
        "",
        "# send-path",
        "",
        "Use workspace-relative paths when possible.",
      ].join("\n"),
    );
  });
});

describe("real shared-skill actions", () => {
  it("keeps only the explicitly shared actions for non-native harnesses", () => {
    const filtered = filterHarnessActions(
      [
        sendPath,
        generateImage,
        generateVideo,
        {
          name: "restart",
          description: "Restart the bot.",
          parameters: { type: "object", properties: {} },
          permissions: {},
          action_fn: async () => "ok",
        },
      ],
      "codex",
    );

    assert.deepEqual(
      filtered.map((action) => action.name),
      ["send_path", "generate_image", "generate_video"],
    );
  });
});
