import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getHarnessSystemPromptSuffix } from "../conversation/create-conversation-runner.js";

describe("getHarnessSystemPromptSuffix", () => {
  it("adds Codex-specific approval guidance", () => {
    const suffix = getHarnessSystemPromptSuffix("codex");
    assert.match(suffix, /Surface relevant internal state/i);
    assert.match(suffix, /pause, ask the user for approval/i);
    assert.match(suffix, /approval policy is `never`/i);
    assert.match(suffix, /sandbox_permissions/i);
    assert.match(suffix, /tool availability/i);
    assert.match(suffix, /trigger approval/i);
  });

  it("returns no extra guidance for other harnesses", () => {
    assert.equal(getHarnessSystemPromptSuffix("native"), "");
  });
});
