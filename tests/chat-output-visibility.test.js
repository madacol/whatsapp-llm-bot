import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  hasLegacyOutputVisibilityOverrides,
  migrateLegacyOutputVisibilityOverrides,
  parseOutputPresentationSetting,
  resolveOutputVisibility,
} from "../chat-output-visibility.js";

describe("chat output visibility", () => {
  it("migrates legacy persisted visibility flags into the new contract", () => {
    const legacy = {
      thinking: false,
      toolStatus: true,
      changes: false,
      usage: false,
      subagents: false,
    };

    assert.equal(hasLegacyOutputVisibilityOverrides(legacy), true);
    assert.deepEqual(migrateLegacyOutputVisibilityOverrides(legacy), {
      reasoning: "hidden",
      tools: "pinnedIndicator",
      fileChanges: "hidden",
      subagents: "hidden",
      usage: "hidden",
    });
  });

  it("does not honor legacy visibility flags during runtime normalization", () => {
    assert.equal(resolveOutputVisibility({ thinking: false }).reasoning, "indicatorInspectable");
    assert.equal(resolveOutputVisibility({ toolStatus: true }).tools, "indicatorInspectable");
    assert.equal(resolveOutputVisibility({ tools: false }).tools, "indicatorInspectable");
    assert.equal(resolveOutputVisibility({ changes: false }).fileChanges, "shown");
  });

  it("parses category option commands", () => {
    assert.deepEqual(parseOutputPresentationSetting("reasoning hidden"), {
      key: "reasoning",
      option: "hidden",
    });
    assert.deepEqual(parseOutputPresentationSetting("tools pinned"), {
      key: "tools",
      option: "pinnedIndicator",
    });
    assert.deepEqual(parseOutputPresentationSetting("middle assistant messages off"), {
      key: "middleAssistantMessages",
      option: "off",
    });
  });
});
