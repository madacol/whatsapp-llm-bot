import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatBashCommand,
  formatSdkToolCall,
  formatToolCallDisplay,
  formatToolResultDisplay,
} from "./tool-display.js";

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

  it("wraps long lines without connectors at the last space under threshold", () => {
    // 90+ char command with no connectors
    const cmd = "pnpm exec tsc --noEmit --project jsconfig.json --strict --noUnusedLocals --noUnusedParameters --skipLibCheck";
    const result = formatBashCommand(cmd);
    const lines = result.split("\n");
    assert.ok(lines.length >= 2, `expected wrapping, got: ${result}`);
    assert.ok(lines[0].length <= 80, `first line too long (${lines[0].length}): ${lines[0]}`);
    // continuation uses 4-space indent
    assert.ok(lines[1].startsWith("    "), `continuation should be 4-space indented: ${lines[1]}`);
  });

  it("wraps long segments after connector splits", () => {
    // Long segment after a pipe
    const cmd = "cat file.txt | grep --include='*.js' --exclude-dir=node_modules --recursive --line-number --with-filename pattern";
    const result = formatBashCommand(cmd);
    // Should split at pipe AND wrap the long grep segment
    assert.ok(result.includes("\n  | grep"), "should split at pipe");
    const lines = result.split("\n");
    for (const line of lines) {
      assert.ok(line.length <= 80, `line too long (${line.length}): ${line}`);
    }
  });

  it("leaves short commands unchanged", () => {
    assert.equal(formatBashCommand("ls -la"), "ls -la");
  });

  it("does not break a line with no spaces within threshold", () => {
    const longToken = "a".repeat(100);
    assert.equal(formatBashCommand(longToken), longToken);
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

  it("wraps long Bash commands in code block", () => {
    const longCmd = "pnpm exec tsc --noEmit --project jsconfig.json --strict --noUnusedLocals --noUnusedParameters --skipLibCheck";
    const result = formatToolCallDisplay(
      tc("Bash", { command: longCmd, description: "Type check" }), true
    );
    assert.ok(Array.isArray(result));
    const block = /** @type {CodeContentBlock} */ (result[0]);
    assert.equal(block.type, "code");
    // Every line in the formatted code should be <= 80 chars
    for (const line of block.code.split("\n")) {
      assert.ok(line.length <= 80, `line too long (${line.length}): ${line}`);
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
