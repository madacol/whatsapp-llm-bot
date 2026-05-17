import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCodexAssistantRuntimeEvent,
  normalizeCodexUsageRuntimeEvent,
} from "../harnesses/codex-runtime-events.js";

describe("Codex runtime event normalization", () => {
  it("normalizes assistant text into a replaceable markdown response event", () => {
    assert.deepEqual(normalizeCodexAssistantRuntimeEvent("Applied fix."), {
      type: "assistant.completed",
      provider: "codex",
      text: "Applied fix.",
      contentType: "markdown",
      responseMode: "replace",
    });
  });

  it("normalizes usage with estimated cost when Codex reports no native cost", () => {
    const event = normalizeCodexUsageRuntimeEvent({
      usage: {
        promptTokens: 1000,
        completionTokens: 200,
        cachedTokens: 100,
        cost: 0,
      },
      runConfig: { model: "gpt-5.3-codex" },
    });

    assert.equal(event.type, "usage.updated");
    assert.equal(event.provider, "codex");
    assert.deepEqual({
      promptTokens: event.usage.promptTokens,
      completionTokens: event.usage.completionTokens,
      cachedTokens: event.usage.cachedTokens,
    }, {
      promptTokens: 1000,
      completionTokens: 200,
      cachedTokens: 100,
    });
    assert.ok(event.usage.cost > 0, "expected a positive estimated cost when native cost is absent");
  });

  it("preserves native cost when Codex reports it", () => {
    assert.deepEqual(normalizeCodexUsageRuntimeEvent({
      usage: {
        promptTokens: 1000,
        completionTokens: 200,
        cachedTokens: 100,
        cost: 0.123,
      },
      runConfig: { model: "gpt-5.3-codex" },
    }), {
      type: "usage.updated",
      provider: "codex",
      usage: {
        promptTokens: 1000,
        completionTokens: 200,
        cachedTokens: 100,
        cost: 0.123,
      },
    });
  });
});
