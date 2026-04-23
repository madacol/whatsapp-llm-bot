import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { failedToolCallUpdate, formatFailedMessageSummary } from "../message-failure-presentation.js";

describe("message failure presentation", () => {
  it("prefixes summaries with a failure marker once", () => {
    assert.equal(formatFailedMessageSummary("*Bash*  `pnpm test`"), "❌ *Bash*  `pnpm test`");
    assert.equal(formatFailedMessageSummary("❌ *Bash*  `pnpm test`"), "❌ *Bash*  `pnpm test`");
  });

  it("builds a text update for failed tool-call handles", () => {
    assert.deepEqual(failedToolCallUpdate({
      kind: "bash",
      toolName: "Bash",
      summary: "*Bash*  `pnpm test`",
      command: "pnpm test",
    }), {
      kind: "text",
      text: "❌ *Bash*  `pnpm test`",
    });
  });
});
