import { describe, it } from "node:test";
import assert from "node:assert/strict";
import config from "../config.js";
import { buildExternalSystemPrompt } from "../conversation/build-harness-run-request.js";

describe("buildExternalSystemPrompt", () => {
  it("keeps the app default prompt for the native harness", () => {
    assert.equal(
      buildExternalSystemPrompt(null, undefined, "\n\nYou are in a group chat", "native"),
      `${config.system_prompt}\n\nYou are in a group chat`,
    );
  });

  it("does not add the app default prompt to Codex by default", () => {
    assert.equal(
      buildExternalSystemPrompt(null, undefined, "\n\nYou are in a group chat", "codex"),
      "",
    );
  });

  it("does not add the app default prompt to Claude SDK by default", () => {
    assert.equal(
      buildExternalSystemPrompt(null, undefined, "\n\nYou are in a group chat", "claude-agent-sdk"),
      "",
    );
  });

  it("still applies explicit chat or persona prompts for SDK harnesses", () => {
    assert.equal(
      buildExternalSystemPrompt(
        /** @type {AgentDefinition} */ ({
          name: "persona",
          description: "desc",
          systemPrompt: "Use the custom persona prompt.",
        }),
        undefined,
        "\n\nYou are in a group chat",
        "codex",
      ),
      "Use the custom persona prompt.\n\nYou are in a group chat",
    );
  });
});
