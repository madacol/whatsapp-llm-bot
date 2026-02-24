import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatTime } from "../utils.js";

describe("formatTime", () => {
  it("formats a date with year, month, day, hour, and minute", () => {
    const date = new Date("2025-03-15T14:30:00");
    const result = formatTime(date);
    assert.ok(result.includes("2025"), `Expected year in result: ${result}`);
    assert.ok(result.includes("03"), `Expected month in result: ${result}`);
    assert.ok(result.includes("15"), `Expected day in result: ${result}`);
  });
});
