import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { truncateWithSummary, html, isHtmlContent } from "../utils.js";

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
