import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatTime, truncateWithSummary, html, isHtmlContent } from "../utils.js";

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

describe("html", () => {
  it("returns a branded HtmlContent object", () => {
    const result = html("<h1>Hello</h1>", "Test");
    assert.equal(result.__brand, "html");
    assert.equal(result.html, "<h1>Hello</h1>");
    assert.equal(result.title, "Test");
  });

  it("works without a title", () => {
    const result = html("<p>No title</p>");
    assert.equal(result.__brand, "html");
    assert.equal(result.html, "<p>No title</p>");
    assert.equal(result.title, undefined);
  });
});

describe("isHtmlContent", () => {
  it("returns true for valid HtmlContent", () => {
    assert.equal(isHtmlContent(html("<h1>Hi</h1>", "Title")), true);
    assert.equal(isHtmlContent({ __brand: "html", html: "<p>test</p>" }), true);
  });

  it("returns false for strings", () => {
    assert.equal(isHtmlContent("hello"), false);
  });

  it("returns false for plain objects", () => {
    assert.equal(isHtmlContent({ html: "<p>test</p>" }), false);
    assert.equal(isHtmlContent({ __brand: "other", html: "<p>test</p>" }), false);
  });

  it("returns false for null, undefined, arrays", () => {
    assert.equal(isHtmlContent(null), false);
    assert.equal(isHtmlContent(undefined), false);
    assert.equal(isHtmlContent([]), false);
  });
});
