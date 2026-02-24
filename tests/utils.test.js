import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatTime, truncateWithSummary } from "../utils.js";

describe("formatTime", () => {
  it("formats a date with year, month, day, hour, and minute", () => {
    const date = new Date("2025-03-15T14:30:00");
    const result = formatTime(date);
    assert.ok(result.includes("2025"), `Expected year in result: ${result}`);
    assert.ok(result.includes("03"), `Expected month in result: ${result}`);
    assert.ok(result.includes("15"), `Expected day in result: ${result}`);
  });
});

describe("truncateWithSummary", () => {
  it("returns short strings unchanged", () => {
    assert.equal(truncateWithSummary("hello", 200), "hello");
  });

  it("truncates long single-line string with char count", () => {
    const long = "a".repeat(250);
    const result = truncateWithSummary(long, 200);
    assert.equal(result, "a".repeat(200) + "… +50 chars");
  });

  it("includes line count when truncated portion has newlines", () => {
    const long = "a".repeat(200) + "\nline2\nline3";
    const result = truncateWithSummary(long, 200);
    assert.ok(result.startsWith("a".repeat(200)));
    assert.ok(result.includes("2 lines"));
  });
});
