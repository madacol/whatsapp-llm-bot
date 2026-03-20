import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NO_OP_HOOKS } from "../harnesses/native.js";
import { wrapHooksWithFallbacks } from "../harnesses/claude-agent-sdk.js";

describe("wrapHooksWithFallbacks", () => {
  it("onAskUser returns empty string when hook throws", async () => {
    const hooks = wrapHooksWithFallbacks({
      ...NO_OP_HOOKS,
      onAskUser: async () => { throw new Error("Connection Closed"); },
    });
    const result = await hooks.onAskUser("Pick one", ["A", "B"]);
    assert.equal(result, "");
  });

  it("onAskUser passes through the return value when hook succeeds", async () => {
    const hooks = wrapHooksWithFallbacks({
      ...NO_OP_HOOKS,
      onAskUser: async () => "B",
    });
    const result = await hooks.onAskUser("Pick one", ["A", "B"]);
    assert.equal(result, "B");
  });

  it("onContinuePrompt returns true (continue) when hook throws", async () => {
    const hooks = wrapHooksWithFallbacks({
      ...NO_OP_HOOKS,
      onContinuePrompt: async () => { throw new Error("Connection was lost"); },
    });
    const result = await hooks.onContinuePrompt();
    assert.equal(result, true);
  });

  it("onDepthLimit returns false (stop) when hook throws", async () => {
    const hooks = wrapHooksWithFallbacks({
      ...NO_OP_HOOKS,
      onDepthLimit: async () => { throw new Error("Connection Closed"); },
    });
    const result = await hooks.onDepthLimit();
    assert.equal(result, false);
  });

  it("onToolCall returns undefined (no editor) when hook throws", async () => {
    const hooks = wrapHooksWithFallbacks({
      ...NO_OP_HOOKS,
      onToolCall: async () => { throw new Error("send failed"); },
    });
    const result = await hooks.onToolCall({ id: "t1", name: "test", arguments: "{}" });
    assert.equal(result, undefined);
  });

  it("onToolCall passes the display context through to the underlying hook", async () => {
    /** @type {unknown[]} */
    let captured = [];
    const hooks = wrapHooksWithFallbacks({
      ...NO_OP_HOOKS,
      onToolCall: async (toolCall, formatToolCall, context) => {
        captured = [toolCall, formatToolCall, context];
      },
    });

    await hooks.onToolCall(
      { id: "t1", name: "Write", arguments: "{}" },
      undefined,
      { oldContent: "before\n" },
    );

    assert.deepEqual(captured, [
      { id: "t1", name: "Write", arguments: "{}" },
      undefined,
      { oldContent: "before\n" },
    ]);
  });

  it("onLlmResponse suppresses error without crashing", async () => {
    const hooks = wrapHooksWithFallbacks({
      ...NO_OP_HOOKS,
      onLlmResponse: async () => { throw new Error("Connection Closed"); },
    });
    // Should not throw
    await hooks.onLlmResponse("hello");
  });

  it("onToolError suppresses error without crashing", async () => {
    const hooks = wrapHooksWithFallbacks({
      ...NO_OP_HOOKS,
      onToolError: async () => { throw new Error("socket dead"); },
    });
    await hooks.onToolError("some error");
  });

  it("onUsage suppresses error without crashing", async () => {
    const hooks = wrapHooksWithFallbacks({
      ...NO_OP_HOOKS,
      onUsage: async () => { throw new Error("Connection was lost"); },
    });
    await hooks.onUsage("$0.05", { prompt: 100, completion: 50, cached: 10 });
  });

  it("passes all arguments through to the underlying hook", async () => {
    /** @type {unknown[]} */
    let captured = [];
    const hooks = wrapHooksWithFallbacks({
      ...NO_OP_HOOKS,
      onAskUser: async (q, opts, preamble, descs) => {
        captured = [q, opts, preamble, descs];
        return "chosen";
      },
    });
    await hooks.onAskUser("question?", ["X", "Y"], "header", ["desc1", "desc2"]);
    assert.deepEqual(captured, ["question?", ["X", "Y"], "header", ["desc1", "desc2"]]);
  });
});
