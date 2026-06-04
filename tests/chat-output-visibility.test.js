import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildOutputVisibilityOverrides,
  normalizeOutputVisibility,
  resolveOutputVisibility,
} from "../chat-output-visibility.js";

describe("chat output visibility", () => {
  it("does not expose tool display as a configurable visibility option", () => {
    assert.deepEqual(
      buildOutputVisibilityOverrides(["toolDetails", "thinking", "changes", "subagents"]),
      {},
    );
  });

  it("ignores legacy tools and commands keys", () => {
    assert.deepEqual(normalizeOutputVisibility({ tools: true }), {});
    assert.equal(resolveOutputVisibility({ tools: true }).toolDetails, false);
    assert.deepEqual(
      normalizeOutputVisibility({ toolDetails: true, tools: true, commands: false }),
      {},
    );
  });
});
