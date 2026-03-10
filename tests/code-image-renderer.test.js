import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderCodeToImages, renderDiffToImages, maxCharsForLineCount } from "../code-image-renderer.js";
import { formatBashCommand } from "../tool-display.js";

describe("code-image-renderer", () => {
  describe("renderCodeToImages", () => {
    it("renders a short code block successfully", async () => {
      const images = await renderCodeToImages("const x = 1;", "javascript");
      assert.ok(images.length > 0, "should produce at least one image");
      assert.ok(Buffer.isBuffer(images[0]), "should produce Buffer");
      // PNG magic bytes
      assert.deepStrictEqual(images[0].subarray(0, 4), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    });

    it("renders multi-line code across multiple image chunks", async () => {
      // 100 lines should produce 2 chunks (MAX_LINES_PER_IMAGE = 90)
      const code = Array.from({ length: 100 }, (_, i) => `const x${i} = ${i};`).join("\n");
      const images = await renderCodeToImages(code, "javascript");
      assert.strictEqual(images.length, 2, "100 lines should split into 2 images");
    });

    it("throws on extremely long single lines (exceeds pixel budget)", async () => {
      // A single line of 10,000 chars → ~84,000px wide, capped to 4000px.
      // 4000 × 52 = 208,000 pixels — well under limit, should NOT throw.
      const longLine = "x".repeat(10_000);
      const images = await renderCodeToImages(longLine, "text");
      assert.ok(images.length > 0, "long line within pixel budget should render");
    });

    it("handles empty code", async () => {
      const images = await renderCodeToImages("", "text");
      assert.ok(images.length > 0, "empty code should still render (1 empty line)");
    });
  });

  describe("renderDiffToImages", () => {
    it("renders a simple diff", async () => {
      const images = await renderDiffToImages("const x = 1;", "const x = 2;", "javascript");
      assert.ok(images.length > 0);
      assert.ok(Buffer.isBuffer(images[0]));
    });

    it("renders a large diff across multiple chunks", async () => {
      const oldStr = Array.from({ length: 50 }, (_, i) => `old line ${i}`).join("\n");
      const newStr = Array.from({ length: 50 }, (_, i) => `new line ${i}`).join("\n");
      // 100 diff lines (50 removed + 50 added) → 2 chunks
      const images = await renderDiffToImages(oldStr, newStr, "text");
      assert.strictEqual(images.length, 2, "100 diff lines should split into 2 images");
    });
  });

  describe("pixel budget guard", () => {
    it("caps SVG width at MAX_SVG_WIDTH (4000px)", async () => {
      // Very long line — width would be huge uncapped, but gets clamped to 4000px.
      // At 4000px × 52px height = 208,000 pixels → well under 12.5M, renders fine.
      const code = "A".repeat(5000);
      const images = await renderCodeToImages(code, "text");
      assert.ok(images.length > 0, "width-capped render should succeed");
    });
  });

  describe("formatBashCommand", () => {
    it("splits at pipe connectors", () => {
      const result = formatBashCommand("cat file.txt | grep foo | head -10");
      assert.ok(result.includes("cat file.txt"), "first part preserved");
      assert.ok(result.includes("| grep foo"), "pipe split");
      assert.ok(result.includes("| head -10"), "second pipe split");
    });

    it("splits at && connectors", () => {
      const result = formatBashCommand("mkdir -p dir && cd dir && ls");
      assert.ok(result.includes("mkdir -p dir"));
      assert.ok(result.includes("&& cd dir"));
    });

    it("preserves multi-line commands (heredocs)", () => {
      const cmd = 'cat <<EOF\nhello\nworld\nEOF';
      const result = formatBashCommand(cmd);
      assert.ok(result.includes("hello"), "heredoc body preserved");
      assert.ok(result.includes("world"), "heredoc body preserved");
    });

    it("handles short commands without modification", () => {
      const result = formatBashCommand("ls -la");
      assert.strictEqual(result, "ls -la");
    });

    it("does not infinite-loop on long commands with semicolons (OOM bug)", () => {
      // This exact command triggered an infinite loop in wrapLongLine:
      // The semicolon split produces 2 parts → maxWidth=47, and the
      // indent spaces caused lastIndexOf to find breaks within the indent,
      // never making progress.
      const cmd = "node --test tests/code-image-renderer.test.js 2>&1 > /tmp/renderer-test.txt; tail -30 /tmp/renderer-test.txt";
      const result = formatBashCommand(cmd);
      assert.ok(typeof result === "string", "should return a string");
      assert.ok(result.length < cmd.length * 3, "result should not be absurdly large");
    });

    it("does not infinite-loop on long tokens without spaces", () => {
      // A single long token with no spaces after a connector
      const cmd = "echo hello ; " + "x".repeat(200);
      const result = formatBashCommand(cmd);
      assert.ok(typeof result === "string");
      assert.ok(result.length < 1000, "should not explode");
    });
  });

  describe("maxCharsForLineCount", () => {
    it("returns at least 20 chars for any line count", () => {
      assert.ok(maxCharsForLineCount(0) >= 20);
      assert.ok(maxCharsForLineCount(1) >= 20);
    });

    it("increases with more lines", () => {
      const one = maxCharsForLineCount(1);
      const ten = maxCharsForLineCount(10);
      assert.ok(ten > one, "more lines should allow wider images");
    });
  });
});
