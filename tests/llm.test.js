import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatUserContent } from "../llm.js";

describe("formatUserContent", () => {
  it("prepends a native-only sender hint when sender metadata is present", async () => {
    const parts = await formatUserContent({
      role: "user",
      senderName: "Alice",
      content: [{ type: "text", text: "hello" }],
    }, new Map());

    assert.deepEqual(parts, [
      { type: "text", text: "Message from Alice" },
      { type: "text", text: "hello" },
    ]);
  });

  it("keeps raw text unchanged when no sender metadata is present", async () => {
    const parts = await formatUserContent({
      role: "user",
      content: [{ type: "text", text: "hello" }],
    }, new Map());

    assert.deepEqual(parts, [
      { type: "text", text: "hello" },
    ]);
  });
});
