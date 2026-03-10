import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatBashCommand,
  formatSdkToolCall,
  formatToolCallDisplay,
  formatToolResultDisplay,
} from "./tool-display.js";
import { maxCharsForLineCount } from "./code-image-renderer.js";

/** @param {string} name @param {Record<string, unknown>} args */
function tc(name, args) {
  return { id: "test-id", name, arguments: JSON.stringify(args) };
}

describe("formatBashCommand", () => {
  it("splits piped commands onto new indented lines", () => {
    const result = formatBashCommand("cat file.txt | grep foo | head -5");
    assert.equal(result, "cat file.txt\n  | grep foo\n  | head -5");
  });

  it("splits first line of heredoc commands but preserves the rest", () => {
    const cmd = "git add . && git commit -m \"$(cat <<'EOF'\nmy message\nEOF\n)\"";
    const result = formatBashCommand(cmd);
    assert.ok(result.startsWith("git add .\n  && git commit"));
    assert.ok(result.includes("\nmy message\nEOF\n"));
  });

  it("preserves multi-line commands with no connectors on first line", () => {
    const cmd = "cat <<EOF\nhello\nEOF";
    assert.equal(formatBashCommand(cmd), cmd);
  });

  it("wraps single commands to fit aspect ratio", () => {
    // Single command (1 connector part) — should use maxCharsForLineCount(1)
    const cmd = "pnpm exec tsc --noEmit --project jsconfig.json --strict --noUnusedLocals --noUnusedParameters --skipLibCheck";
    const maxWidth = maxCharsForLineCount(1);
    const result = formatBashCommand(cmd);
    const lines = result.split("\n");
    assert.ok(lines.length >= 2, `expected wrapping at ${maxWidth} chars, got:\n${result}`);
    for (const line of lines) {
      assert.ok(line.length <= maxWidth, `line too long (${line.length} > ${maxWidth}): ${line}`);
    }
    // continuation uses 4-space indent
    assert.ok(lines[1].startsWith("    "), `continuation should be 4-space indented: ${lines[1]}`);
  });

  it("allows wider lines when more connectors produce more lines", () => {
    // 10 chained commands — maxCharsForLineCount(10) is much wider
    const parts = Array.from({ length: 10 }, (_, i) => `echo "line ${i} with some extra padding text here"`);
    const cmd = parts.join(" && ");
    const maxWidth = maxCharsForLineCount(10);
    const result = formatBashCommand(cmd);
    const lines = result.split("\n");
    assert.ok(lines.length >= 10, `expected many lines, got ${lines.length}`);
    for (const line of lines) {
      assert.ok(line.length <= maxWidth, `line too long (${line.length} > ${maxWidth}): ${line}`);
    }
  });

  it("wraps long segments after connector splits", () => {
    const cmd = "cat file.txt | sort | uniq | grep --include='*.js' --exclude-dir=node_modules --recursive --line-number --with-filename pattern";
    const result = formatBashCommand(cmd);
    assert.ok(result.includes("\n  | grep"), "should split at pipe");
    const maxWidth = maxCharsForLineCount(4); // 4 connector parts
    const lines = result.split("\n");
    for (const line of lines) {
      assert.ok(line.length <= maxWidth, `line too long (${line.length} > ${maxWidth}): ${line}`);
    }
  });

  it("leaves short commands unchanged", () => {
    assert.equal(formatBashCommand("ls -la"), "ls -la");
  });

  it("hard-breaks long tokens with no spaces", () => {
    const longToken = "a".repeat(100);
    const result = formatBashCommand(longToken);
    const lines = result.split("\n");
    // Should be broken into multiple lines, each within maxWidth
    assert.ok(lines.length >= 2, `expected hard-break, got single line of ${longToken.length} chars`);
    // No empty continuation lines (the old double-backslash bug)
    for (const line of lines) {
      const trimmed = line.replace(/\\$/, "").trim();
      assert.ok(trimmed.length > 0, `empty continuation line: ${JSON.stringify(line)}`);
    }
  });

  it("does not produce empty continuation lines from indent-space breaks (OOM regression)", () => {
    // This exact pattern caused the OOM: connectors narrow maxWidth, then
    // lastIndexOf(" ", wrapWidth) found spaces inside the indent prefix,
    // producing empty "\" lines and (before the fix) an infinite loop.
    const cmd = 'pnpm exec jest --testPathPattern="tests/code-image-renderer.test.js" --no-coverage 2>&1 ; echo "Exit code: $?"';
    const result = formatBashCommand(cmd);
    const lines = result.split("\n");
    for (const line of lines) {
      const content = line.replace(/\\$/, "").trim();
      assert.ok(content.length > 0, `empty continuation line in: ${JSON.stringify(line)}\nfull output:\n${result}`);
    }
  });

  it("hard-breaks use backslash without leading space", () => {
    // When breaking mid-token (no space), the continuation should be "\"
    // not " \" — the latter would escape the space in bash
    const cmd = "echo " + "x".repeat(150);
    const result = formatBashCommand(cmd);
    const lines = result.split("\n");
    for (let i = 0; i < lines.length - 1; i++) {
      if (!lines[i].includes(" \\")) {
        // This is a hard-break line — should end with "\" not " \"
        assert.ok(lines[i].endsWith("\\"), `expected trailing backslash: ${lines[i]}`);
      }
    }
  });

  it("space-breaks use backslash with leading space", () => {
    // When breaking at a word boundary, the continuation should be " \"
    const cmd = "ls -la /home/user/some/path /home/user/another/path /home/user/third/path";
    const result = formatBashCommand(cmd);
    const lines = result.split("\n");
    const spaceBreaks = lines.filter(l => l.endsWith(" \\"));
    // If the command is long enough to wrap, space breaks should use " \"
    if (lines.length > 1) {
      assert.ok(spaceBreaks.length > 0, `expected space-break lines with " \\", got:\n${result}`);
    }
  });
});

describe("formatSdkToolCall", () => {
  it("returns null for missing required args", () => {
    assert.equal(formatSdkToolCall("Read", {}), null);
    assert.equal(formatSdkToolCall("Grep", {}), null);
    assert.equal(formatSdkToolCall("Glob", {}), null);
    assert.equal(formatSdkToolCall("WebSearch", {}), null);
  });

  it("returns null for unknown tools", () => {
    assert.equal(formatSdkToolCall("MadeUpTool", { x: 1 }), null);
  });
});

describe("formatToolCallDisplay", () => {
  it("renders Bash as code block with description as caption", () => {
    const result = formatToolCallDisplay(
      tc("Bash", { command: "npm test", description: "Run tests" }), true
    );
    assert.ok(Array.isArray(result));
    const block = /** @type {CodeContentBlock} */ (result[0]);
    assert.equal(block.type, "code");
    assert.equal(block.language, "bash");
    assert.equal(block.caption, "*Run tests*");
  });

  it("wraps long Bash commands in code block to fit aspect ratio", () => {
    const longCmd = "pnpm exec tsc --noEmit --project jsconfig.json --strict --noUnusedLocals --noUnusedParameters --skipLibCheck";
    const result = formatToolCallDisplay(
      tc("Bash", { command: longCmd, description: "Type check" }), true
    );
    assert.ok(Array.isArray(result));
    const block = /** @type {CodeContentBlock} */ (result[0]);
    assert.equal(block.type, "code");
    const maxWidth = maxCharsForLineCount(1); // single command, no connectors
    for (const line of block.code.split("\n")) {
      assert.ok(line.length <= maxWidth, `line too long (${line.length} > ${maxWidth}): ${line}`);
    }
  });

  it("renders Edit as diff block for known languages", () => {
    const result = formatToolCallDisplay(
      tc("Edit", { file_path: "/a.js", old_string: "foo", new_string: "bar" }), true
    );
    assert.ok(Array.isArray(result));
    assert.equal(result[0].type, "diff");
  });

  it("renders Edit as text fallback for unknown languages", () => {
    const result = formatToolCallDisplay(
      tc("Edit", { file_path: "/a.xyz", old_string: "foo", new_string: "bar" }), true
    );
    assert.ok(Array.isArray(result));
    assert.equal(result[0].type, "text");
  });

  it("in non-debug mode, returns just the description when present", () => {
    const result = formatToolCallDisplay(tc("anything", { description: "doing stuff" }), false);
    assert.equal(result, "doing stuff");
  });

  it("in non-debug mode without description, Bash still renders as code block", () => {
    const result = formatToolCallDisplay(tc("Bash", { command: "ls" }), false);
    assert.ok(Array.isArray(result));
    assert.equal(result[0].type, "code");
  });
});

describe("formatToolResultDisplay", () => {
  it("returns null when silent", () => {
    assert.equal(
      formatToolResultDisplay([{ type: "text", text: "hi" }], "tool", { silent: true }, false),
      null
    );
  });

  it("autoContinue suppresses text but keeps non-text blocks", () => {
    /** @type {ImageContentBlock} */
    const img = { type: "image", encoding: "base64", mime_type: "image/png", data: "abc" };
    const result = formatToolResultDisplay(
      [{ type: "text", text: "ignored" }, img], "tool", { autoContinue: true }, false
    );
    assert.ok(result);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].content, [img]);
  });

  it("autoContinue returns null when only text blocks", () => {
    assert.equal(
      formatToolResultDisplay([{ type: "text", text: "hi" }], "tool", { autoContinue: true }, false),
      null
    );
  });

  it("final answer uses reply (not send) with all blocks", () => {
    const blocks = [{ type: "text", text: "answer" }];
    const result = formatToolResultDisplay(/** @type {ToolContentBlock[]} */ (blocks), "tool", {}, false);
    assert.ok(result);
    assert.equal(result[0].source, "reply");
  });
});
