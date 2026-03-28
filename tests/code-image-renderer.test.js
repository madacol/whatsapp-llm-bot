import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  renderCodeToImages,
  renderDiffToImages,
  renderUnifiedDiffToImages,
  maxCharsForLineCount,
  wrapAnnotatedLinesForDisplay,
} from "../code-image-renderer.js";
import { formatBashCommand } from "../tool-display.js";

/**
 * @param {Buffer} png
 * @returns {{ width: number, height: number }}
 */
function getPngDimensions(png) {
  assert.deepStrictEqual(png.subarray(12, 16), Buffer.from("IHDR"));
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
  };
}

describe("code-image-renderer", () => {
  describe("renderCodeToImages", () => {
    it("renders a short code block successfully", async () => {
      const images = await renderCodeToImages("const x = 1;", "javascript");
      assert.ok(images.length > 0, "should produce at least one image");
      assert.ok(Buffer.isBuffer(images[0]), "should produce Buffer");
      // PNG magic bytes
      assert.deepStrictEqual(images[0].subarray(0, 4), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    });

    it("splits 100 lines of narrow code into shorter images", async () => {
      const code = Array.from({ length: 100 }, (_, i) => `const x${i} = ${i};`).join("\n");
      const images = await renderCodeToImages(code, "javascript");
      assert.strictEqual(images.length, 2, "100 narrow lines should split into two less-dense images");
    });

    it("splits into multiple images when pixel budget is exceeded", async () => {
      // Wide code should still split once the shared line cap is exceeded.
      const wideLine = "x".repeat(500);
      const code = Array.from({ length: 200 }, () => wideLine).join("\n");
      const images = await renderCodeToImages(code, "text");
      assert.ok(images.length >= 2, `200 wide lines should split, got ${images.length} image(s)`);
    });

    it("wraps long code lines into a bounded, taller image", async () => {
      const longLine = Array.from({ length: 40 }, (_, index) => `segment${index}`).join(" ");
      const images = await renderCodeToImages(longLine, "text");
      assert.equal(images.length, 1, "wrapped long code should still fit in a single image");
      const { width, height } = getPngDimensions(images[0]);
      assert.ok(width <= 560, `expected wrapped code image to stay bounded, got ${width}px`);
      assert.ok(height >= 160, `expected wrapped code image to grow taller, got ${height}px`);
    });

    it("hard-wraps extremely long single tokens instead of rendering an excessively wide image", async () => {
      const longLine = "x".repeat(10_000);
      const images = await renderCodeToImages(longLine, "text");
      assert.ok(images.length > 0, "very long single-token code should still render");
      const { width, height } = getPngDimensions(images[0]);
      assert.ok(width <= 560, `expected hard-wrapped code image to stay bounded, got ${width}px`);
      assert.ok(height >= 1000, `expected hard-wrapped code image to grow taller, got ${height}px`);
    });

    it("keeps lines under the 3x wrap threshold on a single rendered line", async () => {
      const baseWrapWidth = maxCharsForLineCount(1);
      const line = "x".repeat(baseWrapWidth * 2);
      const images = await renderCodeToImages(line, "text");

      assert.equal(images.length, 1, "single-line code should stay in one image");

      const { width, height } = getPngDimensions(images[0]);
      assert.equal(height, 52, `expected no wrapping under the wider threshold, got ${height}px tall image`);
      assert.ok(width > 300, `expected the wider threshold to allow a wider single line, got ${width}px`);
    });

    it("returns empty array for empty code", async () => {
      const images = await renderCodeToImages("", "text");
      assert.strictEqual(images.length, 0, "empty code should produce no images");
    });
  });

  describe("renderDiffToImages", () => {
    it("renders a simple diff", async () => {
      const images = await renderDiffToImages("const x = 1;", "const x = 2;", "javascript");
      assert.ok(images.length > 0);
      assert.ok(Buffer.isBuffer(images[0]));
    });

    it("renders a large diff across multiple chunks when pixel budget exceeded", async () => {
      // Completely different content → 100 removed + 100 added = 200 diff lines.
      // Shared wrapping and chunking should split this into multiple images.
      const oldStr = Array.from({ length: 100 }, (_, i) => "old_" + "x".repeat(500) + i).join("\n");
      const newStr = Array.from({ length: 100 }, (_, i) => "new_" + "y".repeat(500) + i).join("\n");
      const images = await renderDiffToImages(oldStr, newStr, "text");
      assert.ok(images.length >= 2, `200 wide diff lines should split, got ${images.length} image(s)`);
    });

    it("renders unified diff hunks without reconstructing the whole file", async () => {
      const images = await renderUnifiedDiffToImages([
        "--- a/plain.txt",
        "+++ b/plain.txt",
        "@@ -10,5 +10,5 @@",
        " context before",
        "-old line",
        "+new line",
        " context after",
      ].join("\n"), "text");

      assert.ok(images.length > 0, "unified diff should produce at least one image");
      assert.ok(Buffer.isBuffer(images[0]), "unified diff render should return image buffers");
    });

    it("wraps long unified diff lines into a bounded, taller image", async () => {
      const longLine = Array.from({ length: 40 }, (_, index) => `segment${index}`).join(" ");
      const images = await renderUnifiedDiffToImages([
        "--- a/plain.txt",
        "+++ b/plain.txt",
        "@@ -1 +1 @@",
        `-${longLine}`,
        `+${longLine} changed`,
      ].join("\n"), "text");

      assert.equal(images.length, 1, "wrapped long unified diff should still fit in a single image");
      const { width, height } = getPngDimensions(images[0]);
      assert.ok(width <= 620, `expected wrapped unified diff image to stay bounded, got ${width}px`);
      assert.ok(height >= 300, `expected wrapped unified diff image to grow taller, got ${height}px`);
    });

    it("splits unified diffs into multiple shorter images to keep them less dense", async () => {
      const diffLines = [
        "--- a/plain.txt",
        "+++ b/plain.txt",
        "@@ -1,40 +1,40 @@",
      ];

      for (let index = 0; index < 40; index++) {
        diffLines.push(`-const oldValue${index} = ${index};`);
        diffLines.push(`+const newValue${index} = ${index + 1};`);
      }

      const images = await renderUnifiedDiffToImages(diffLines.join("\n"), "javascript");
      assert.ok(images.length >= 2, `expected unified diff to split into multiple images, got ${images.length}`);
    });
  });

  describe("pixel budget guard", () => {
    it("keeps very wide code images split across multiple wrapped chunks", async () => {
      const wideLine = "A".repeat(1500);
      const code = Array.from({ length: 60 }, () => wideLine).join("\n");
      const images = await renderCodeToImages(code, "text");
      assert.ok(images.length >= 3, `expected wrapped wide code to split across multiple images, got ${images.length}`);
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

  describe("wrapAnnotatedLinesForDisplay", () => {
    it("indents wrapped continuation lines", () => {
      const wrapped = wrapAnnotatedLinesForDisplay([
        {
          tokens: [{ content: "alpha beta gamma delta", color: "#e6edf3", offset: 0 }],
          bg: "#123456",
          gutter: "#654321",
          prefix: "+",
        },
      ], {
        maxContentChars: 12,
      });

      assert.equal(wrapped.length, 3, `expected wrapping into three lines, got ${wrapped.length}`);
      assert.equal(wrapped[0]?.tokens.map(token => token.content).join(""), "alpha beta");
      assert.equal(wrapped[1]?.tokens.map(token => token.content).join(""), "    gamma");
      assert.equal(wrapped[2]?.tokens.map(token => token.content).join(""), "    delta");
      assert.equal(wrapped[1]?.prefix, "+");
      assert.equal(wrapped[1]?.bg, "#123456");
      assert.equal(wrapped[1]?.gutter, "#654321");
    });
  });
});
