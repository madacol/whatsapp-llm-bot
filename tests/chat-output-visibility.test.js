import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildOutputVisibilityOverrides,
  normalizeOutputVisibility,
  resolveOutputVisibility,
} from "../chat-output-visibility.js";

describe("chat output visibility", () => {
  it("uses toolDetails as the canonical full tool output key", () => {
    assert.deepEqual(
      buildOutputVisibilityOverrides(["toolDetails", "thinking", "changes", "subagents"]),
      { toolDetails: true },
    );
  });

  it("normalizes legacy tools and commands keys as full tool details", () => {
    assert.deepEqual(normalizeOutputVisibility({ tools: true }), { toolDetails: true });
    assert.equal(resolveOutputVisibility({ tools: true }).toolDetails, true);
    assert.deepEqual(
      normalizeOutputVisibility({ toolDetails: true, tools: true, commands: false }),
      { toolDetails: true },
    );
  });
});
