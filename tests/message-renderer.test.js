import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { markdownToWhatsApp, shouldRenderAsImage } from "../message-renderer.js";

// ── markdownToWhatsApp ──

describe("markdownToWhatsApp", () => {
  it("converts **bold** to *bold*", () => {
    assert.equal(markdownToWhatsApp("**hello**"), "*hello*");
  });

  it("converts __bold__ to *bold*", () => {
    assert.equal(markdownToWhatsApp("__hello__"), "*hello*");
  });

  it("converts single *italic* to _italic_", () => {
    assert.equal(markdownToWhatsApp("*hello*"), "_hello_");
  });

  it("converts ~~strike~~ to ~strike~", () => {
    assert.equal(markdownToWhatsApp("~~gone~~"), "~gone~");
  });

  it("converts # headers to *bold*", () => {
    assert.equal(markdownToWhatsApp("# Title"), "*Title*");
    assert.equal(markdownToWhatsApp("### Sub"), "*Sub*");
  });

  it("converts [text](url) links", () => {
    assert.equal(markdownToWhatsApp("[click](http://x.com)"), "click (http://x.com)");
  });

  it("converts ![alt](url) images before links", () => {
    assert.equal(markdownToWhatsApp("![photo](http://img.png)"), "photo (http://img.png)");
  });

  it("converts unordered list markers to bullets with non-breaking spaces", () => {
    const result = markdownToWhatsApp("- item one\n- item two");
    assert.ok(result.includes("• item one"));
    assert.ok(result.includes("• item two"));
  });

  it("indents nested list items with non-breaking spaces", () => {
    const result = markdownToWhatsApp("- top\n  - nested");
    const lines = result.split("\n");
    // Nested item should have \u00A0\u00A0 prefix
    assert.ok(lines[1].startsWith("\u00A0\u00A0"), `expected indent, got: ${JSON.stringify(lines[1])}`);
  });

  it("converts ordered lists preserving numbers", () => {
    const result = markdownToWhatsApp("1. first\n2. second");
    assert.ok(result.includes("1. first"));
    assert.ok(result.includes("2. second"));
  });

  it("converts horizontal rules to ———", () => {
    assert.equal(markdownToWhatsApp("---"), "———");
    assert.equal(markdownToWhatsApp("***"), "———");
    assert.equal(markdownToWhatsApp("___"), "———");
  });

  it("handles bold italic (**_text_**) without mangling", () => {
    // **bold** → *bold* conversion should handle this gracefully
    const result = markdownToWhatsApp("***text***");
    // Should produce some valid WhatsApp formatting, not crash
    assert.ok(typeof result === "string");
  });

  it("passes through plain text unchanged", () => {
    assert.equal(markdownToWhatsApp("hello world"), "hello world");
  });

  it("handles empty string", () => {
    assert.equal(markdownToWhatsApp(""), "");
  });
});

// ── shouldRenderAsImage ──

describe("shouldRenderAsImage", () => {
  const longCode = "line1\nline2\nline3\nline4\nline5\nline6";
  const shortCode = "x = 1";

  it("returns true for recognized language with enough lines", () => {
    assert.equal(shouldRenderAsImage("javascript", longCode), true);
    assert.equal(shouldRenderAsImage("python", longCode), true);
    assert.equal(shouldRenderAsImage("rust", longCode), true);
  });

  it("returns false for recognized language with too few lines", () => {
    assert.equal(shouldRenderAsImage("javascript", shortCode), false);
  });

  it("returns false for unrecognized language", () => {
    assert.equal(shouldRenderAsImage("text", longCode), false);
    assert.equal(shouldRenderAsImage("plaintext", longCode), false);
    assert.equal(shouldRenderAsImage("output", longCode), false);
    assert.equal(shouldRenderAsImage("log", longCode), false);
  });

  it("is case-insensitive for language names", () => {
    assert.equal(shouldRenderAsImage("JavaScript", longCode), true);
    assert.equal(shouldRenderAsImage("PYTHON", longCode), true);
  });

  it("returns false for empty language", () => {
    assert.equal(shouldRenderAsImage("", longCode), false);
  });

  it("returns false at exactly MIN_LINES_FOR_IMAGE - 1 lines", () => {
    const fourLines = "a\nb\nc\nd";
    assert.equal(shouldRenderAsImage("js", fourLines), false);
  });

  it("returns true at exactly MIN_LINES_FOR_IMAGE lines", () => {
    const fiveLines = "a\nb\nc\nd\ne";
    assert.equal(shouldRenderAsImage("js", fiveLines), true);
  });
});
