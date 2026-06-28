import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { failedToolCallUpdate, formatFailedMessageSummary } from "../message-failure-presentation.js";

describe("message failure presentation", () => {
  it("prefixes summaries with a failure marker once", () => {
    assert.equal(formatFailedMessageSummary("*Shell*  `pnpm test`"), "❌ *Shell*  `pnpm test`");
    assert.equal(formatFailedMessageSummary("❌ *Shell*  `pnpm test`"), "❌ *Shell*  `pnpm test`");
  });

  it("builds a text update for failed tool-call handles", () => {
    assert.deepEqual(failedToolCallUpdate({
      kind: "bash",
      toolName: "Shell",
      summary: "*Shell*  `pnpm test`",
      command: "pnpm test",
      inspectMode: "bash",
    }), {
      kind: "text",
      text: "❌ *Shell*  `pnpm test`",
    });
  });
});
