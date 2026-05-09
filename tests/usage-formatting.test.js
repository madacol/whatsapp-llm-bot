import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatUsageEventText } from "../usage-formatting.js";

describe("formatUsageEventText", () => {
  it("includes derived and Codex app-server usage stats when available", () => {
    assert.equal(formatUsageEventText({
      kind: "usage",
      cost: "0.028234",
      tokens: {
        prompt: 114529,
        cached: 111488,
        completion: 243,
        total: 114772,
        reasoning: 12,
        contextWindow: 400000,
      },
    }), "Cost: 0.028234 | prompt=114529 cached=111488 uncached=3041 completion=243 reasoning=12 total=114772 cache=97.3% ctx=28.7% remaining=285228");
  });

  it("keeps basic usage lines compact when optional stats are unavailable", () => {
    assert.equal(formatUsageEventText({
      kind: "usage",
      cost: "$0.05",
      tokens: {
        prompt: 100,
        cached: 10,
        completion: 50,
      },
    }), "Cost: $0.05 | prompt=100 cached=10 uncached=90 completion=50 cache=10.0%");
  });
});
