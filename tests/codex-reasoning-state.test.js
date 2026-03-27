import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCodexReasoningState } from "../harnesses/codex-reasoning-state.js";

describe("codex reasoning state", () => {
  it("accumulates snapshots, deltas, and encrypted metadata into a semantic snapshot", () => {
    const state = createCodexReasoningState();

    assert.deepEqual(state.apply({
      itemId: "reason-1",
      status: "started",
      summarySnapshot: [],
      contentSnapshot: [],
    }), {
      itemId: "reason-1",
      status: "started",
      summaryParts: [],
      contentParts: [],
    });

    assert.deepEqual(state.apply({
      itemId: "reason-1",
      status: "updated",
      summaryDelta: {
        index: 0,
        text: "Plan the approach.",
      },
    }), {
      itemId: "reason-1",
      status: "updated",
      summaryParts: ["Plan the approach."],
      contentParts: [],
      text: "Plan the approach.",
    });

    assert.deepEqual(state.apply({
      itemId: "reason-1",
      status: "updated",
      contentDelta: {
        index: 0,
        text: "Inspect the file, then patch the bug.",
      },
    }), {
      itemId: "reason-1",
      status: "updated",
      summaryParts: ["Plan the approach."],
      contentParts: ["Inspect the file, then patch the bug."],
      text: "Inspect the file, then patch the bug.",
    });

    assert.deepEqual(state.apply({
      status: "updated",
      hasEncryptedContent: true,
    }), {
      itemId: "reason-1",
      status: "updated",
      summaryParts: ["Plan the approach."],
      contentParts: ["Inspect the file, then patch the bug."],
      text: "Inspect the file, then patch the bug.",
      hasEncryptedContent: true,
    });
  });
});
