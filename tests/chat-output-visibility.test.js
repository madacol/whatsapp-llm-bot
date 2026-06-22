import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildOutputVisibilityOverrides,
  resolveOutputVisibility,
} from "../chat-output-visibility.js";

describe("chat output visibility", () => {
  it("exposes pinned tool status as an opt-in visibility option", () => {
    assert.deepEqual(
      buildOutputVisibilityOverrides(["toolStatus", "thinking", "changes", "subagents"]),
      { toolStatus: true },
    );
    assert.equal(resolveOutputVisibility({}).toolStatus, false);
    assert.equal(resolveOutputVisibility({ toolStatus: true }).toolStatus, true);
  });
});
