import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatBashCommand,
  formatSdkToolCall,
  langFromPath,
  formatToolCallDisplay,
  formatToolResultDisplay,
} from "./tool-display.js";

// Helper to build a toolCall object as expected by formatToolCallDisplay
/** @param {string} name @param {Record<string, unknown>} args */
function tc(name, args) {
  return { id: "test-id", name, arguments: JSON.stringify(args) };
}

/** @returns {ImageContentBlock} */
function fakeImage() {
  return { type: "image", encoding: "base64", mime_type: "image/png", data: "abc" };
}

describe("formatBashCommand", () => {
  it("returns simple commands unchanged", () => {
    assert.equal(formatBashCommand("ls -la"), "ls -la");
  });

  it("splits at pipe onto new indented line", () => {
    const result = formatBashCommand("cat file.txt | grep foo | head -5");
    assert.equal(result, "cat file.txt\n  | grep foo\n  | head -5");
  });

  it("splits at && connector", () => {
    const result = formatBashCommand("npm install && npm test");
    assert.equal(result, "npm install\n  && npm test");
  });

  it("splits at || connector", () => {
    const result = formatBashCommand("test -f x || echo missing");
    assert.equal(result, "test -f x\n  || echo missing");
  });

  it("splits at semicolon", () => {
    const result = formatBashCommand("cd /tmp ; ls");
    assert.equal(result, "cd /tmp\n  ; ls");
  });

  it("handles mixed connectors", () => {
    const result = formatBashCommand("a && b | c ; d");
    assert.equal(result, "a\n  && b\n  | c\n  ; d");
  });

  it("only reformats first line of multi-line commands (heredoc)", () => {
    const cmd = "cat <<EOF && echo done\nhello\nworld\nEOF";
    const result = formatBashCommand(cmd);
    // First line split at &&, rest preserved verbatim
    assert.equal(result, "cat <<EOF\n  && echo done\nhello\nworld\nEOF");
  });

  it("preserves multi-line command with no connectors on first line", () => {
    const cmd = "cat <<EOF\nhello\nEOF";
    assert.equal(formatBashCommand(cmd), cmd);
  });
});

describe("formatSdkToolCall", () => {
  it("formats Read with just path", () => {
    assert.equal(formatSdkToolCall("Read", { file_path: "/a/b.js" }), "*Read*  `/a/b.js`");
  });

  it("formats Read with offset and limit", () => {
    const result = formatSdkToolCall("Read", { file_path: "/a/b.js", offset: 10, limit: 50 });
    assert.equal(result, "*Read*  `/a/b.js`  _from L10, 50 lines_");
  });

  it("formats Read with only offset", () => {
    const result = formatSdkToolCall("Read", { file_path: "/a/b.js", offset: 5 });
    assert.equal(result, "*Read*  `/a/b.js`  _from L5_");
  });

  it("returns null for Read without file_path", () => {
    assert.equal(formatSdkToolCall("Read", {}), null);
  });

  it("formats Grep with pattern, path, and glob", () => {
    const result = formatSdkToolCall("Grep", { pattern: "TODO", path: "/src", glob: "*.js" });
    assert.equal(result, "*Grep*  `TODO`  in `/src`  (*.js)");
  });

  it("formats Grep with just pattern", () => {
    assert.equal(formatSdkToolCall("Grep", { pattern: "foo" }), "*Grep*  `foo`");
  });

  it("returns null for Grep without pattern", () => {
    assert.equal(formatSdkToolCall("Grep", { path: "/src" }), null);
  });

  it("formats Glob with pattern and path", () => {
    assert.equal(
      formatSdkToolCall("Glob", { pattern: "**/*.ts", path: "/app" }),
      "*Glob*  `**/*.ts`  in `/app`"
    );
  });

  it("returns null for Glob without pattern", () => {
    assert.equal(formatSdkToolCall("Glob", {}), null);
  });

  it("formats WebSearch", () => {
    assert.equal(formatSdkToolCall("WebSearch", { query: "node test runner" }), "*Search*  _node test runner_");
  });

  it("returns null for WebSearch without query", () => {
    assert.equal(formatSdkToolCall("WebSearch", {}), null);
  });

  it("formats WebFetch", () => {
    assert.equal(formatSdkToolCall("WebFetch", { url: "https://x.com" }), "*Fetch*  https://x.com");
  });

  it("returns null for WebFetch without url", () => {
    assert.equal(formatSdkToolCall("WebFetch", {}), null);
  });

  it("formats Agent", () => {
    assert.equal(formatSdkToolCall("Agent", { description: "summarize" }), "*Agent*  _summarize_");
  });

  it("returns null for Agent without description", () => {
    assert.equal(formatSdkToolCall("Agent", {}), null);
  });

  it("returns null for unknown tool", () => {
    assert.equal(formatSdkToolCall("UnknownTool", { x: 1 }), null);
  });
});

describe("langFromPath", () => {
  it("returns language for common extensions", () => {
    assert.equal(langFromPath("/src/app.js"), "javascript");
    assert.equal(langFromPath("test.ts"), "typescript");
    assert.equal(langFromPath("/a/b.py"), "python");
    assert.equal(langFromPath("style.css"), "css");
    assert.equal(langFromPath("config.yaml"), "yaml");
    assert.equal(langFromPath("query.sql"), "sql");
  });

  it("handles Dockerfile and Makefile (extensionless)", () => {
    assert.equal(langFromPath("/project/Dockerfile"), "dockerfile");
    assert.equal(langFromPath("Makefile"), "makefile");
  });

  it("is case-insensitive for Dockerfile/Makefile", () => {
    assert.equal(langFromPath("dockerfile"), "dockerfile");
  });

  it("returns empty string for unknown extension", () => {
    assert.equal(langFromPath("data.xyz"), "");
  });

  it("returns empty string for extensionless non-special files", () => {
    assert.equal(langFromPath("README"), "");
  });
});

describe("formatToolCallDisplay", () => {
  it("renders Bash command as code block", () => {
    const result = formatToolCallDisplay(tc("Bash", { command: "ls -la" }), true);
    assert.ok(Array.isArray(result));
    assert.equal(result[0].type, "code");
    assert.equal(result[0].code, "ls -la");
    assert.equal(result[0].language, "bash");
  });

  it("includes description as caption for Bash", () => {
    const result = formatToolCallDisplay(tc("Bash", { command: "npm test", description: "Run tests" }), true);
    assert.ok(Array.isArray(result));
    const block = /** @type {CodeContentBlock} */ (result[0]);
    assert.equal(block.caption, "*Run tests*");
  });

  it("Bash without description has no caption", () => {
    const result = formatToolCallDisplay(tc("Bash", { command: "echo hi" }), true);
    assert.ok(Array.isArray(result));
    const block = /** @type {CodeContentBlock} */ (result[0]);
    assert.equal(block.caption, undefined);
  });

  it("renders SDK tool as string", () => {
    const result = formatToolCallDisplay(tc("Read", { file_path: "/a.js" }), true);
    assert.equal(result, "*Read*  `/a.js`");
  });

  it("renders Edit with diff block when language known", () => {
    const result = formatToolCallDisplay(
      tc("Edit", { file_path: "/a.js", old_string: "foo", new_string: "bar" }),
      true
    );
    assert.ok(Array.isArray(result));
    assert.equal(result[0].type, "diff");
    assert.equal(result[0].oldStr, "foo");
    assert.equal(result[0].newStr, "bar");
    assert.equal(result[0].language, "javascript");
  });

  it("renders Edit as text when language unknown", () => {
    const result = formatToolCallDisplay(
      tc("Edit", { file_path: "/a.xyz", old_string: "foo", new_string: "bar" }),
      true
    );
    assert.ok(Array.isArray(result));
    assert.equal(result[0].type, "text");
  });

  it("renders Write with code block when language known and content non-empty", () => {
    const result = formatToolCallDisplay(
      tc("Write", { file_path: "/a.py", content: "print('hi')" }),
      true
    );
    assert.ok(Array.isArray(result));
    assert.equal(result[0].type, "code");
    assert.equal(result[0].language, "python");
  });

  it("renders Write as text when content is whitespace-only", () => {
    const result = formatToolCallDisplay(
      tc("Write", { file_path: "/a.py", content: "   " }),
      true
    );
    assert.ok(Array.isArray(result));
    assert.equal(result[0].type, "text");
  });

  it("in non-debug mode, returns description string if present", () => {
    const result = formatToolCallDisplay(tc("customTool", { description: "doing stuff" }), false);
    assert.equal(result, "doing stuff");
  });

  it("in non-debug mode without description, falls through to normal formatting", () => {
    const result = formatToolCallDisplay(tc("Bash", { command: "ls" }), false);
    // Bash still renders as code block even in non-debug
    assert.ok(Array.isArray(result));
  });

  it("generic fallback uses actionFormatter when provided", () => {
    const result = formatToolCallDisplay(
      tc("customTool", { x: 1 }),
      true,
      (params) => `formatted(${JSON.stringify(params)})`
    );
    assert.ok(typeof result === "string");
    assert.ok(result.includes("formatted("));
  });

  it("generic fallback shows single arg value without key", () => {
    const result = formatToolCallDisplay(tc("customTool", { query: "hello" }), false);
    assert.equal(result, "customTool: hello");
  });

  it("generic fallback shows multiple args with keys", () => {
    const result = formatToolCallDisplay(tc("customTool", { a: "x", b: "y" }), false);
    assert.equal(result, "customTool: a: x, b: y");
  });

  it("generic debug fallback bolds tool name", () => {
    const result = formatToolCallDisplay(tc("customTool", {}), true);
    assert.equal(result, "*customTool*");
  });

  it("non-debug omits long inline args (>80 chars)", () => {
    const longVal = "x".repeat(81);
    const result = formatToolCallDisplay(tc("customTool", { key: longVal }), false);
    // Single arg value exceeds 80 chars → not appended in non-debug mode
    assert.equal(result, "customTool");
  });
});

describe("formatToolResultDisplay", () => {
  it("returns null when permissions.silent is true", () => {
    const result = formatToolResultDisplay(
      [{ type: "text", text: "hi" }],
      "test",
      { silent: true },
      false
    );
    assert.equal(result, null);
  });

  it("in debug mode, sends toolName prefix with text summary", () => {
    const result = formatToolResultDisplay(
      [{ type: "text", text: "output line" }],
      "Bash",
      {},
      true
    );
    assert.ok(result);
    assert.equal(result.length, 1);
    assert.equal(result[0].source, "send");
    assert.equal(result[0].content, "Bash: output line");
  });

  it("in debug mode with no text blocks, shows 'Done.'", () => {
    const img = fakeImage();
    const result = formatToolResultDisplay(
      [img],
      "Bash",
      {},
      true
    );
    assert.ok(result);
    assert.equal(result[0].content, "Bash: Done.");
    // Non-text block sent separately
    assert.equal(result.length, 2);
    assert.equal(result[1].source, "send");
  });

  it("in debug mode, sends non-text blocks as separate item", () => {
    const img = fakeImage();
    /** @type {ToolContentBlock[]} */
    const blocks = [
      { type: "text", text: "info" },
      img,
    ];
    const result = formatToolResultDisplay(blocks, "tool", {}, true);
    assert.ok(result);
    assert.equal(result.length, 2);
    assert.deepEqual(result[1].content, [img]);
  });

  it("autoContinue returns non-text blocks only", () => {
    const img = fakeImage();
    /** @type {ToolContentBlock[]} */
    const blocks = [
      { type: "text", text: "ignored" },
      img,
    ];
    const result = formatToolResultDisplay(blocks, "tool", { autoContinue: true }, false);
    assert.ok(result);
    assert.equal(result.length, 1);
    assert.equal(result[0].source, "send");
    assert.deepEqual(result[0].content, [img]);
  });

  it("autoContinue returns null when only text blocks", () => {
    const result = formatToolResultDisplay(
      [{ type: "text", text: "hi" }],
      "tool",
      { autoContinue: true },
      false
    );
    assert.equal(result, null);
  });

  it("final answer (non-debug, non-autoContinue) replies with all blocks", () => {
    const img = fakeImage();
    /** @type {ToolContentBlock[]} */
    const blocks = [
      { type: "text", text: "answer" },
      img,
    ];
    const result = formatToolResultDisplay(blocks, "tool", {}, false);
    assert.ok(result);
    assert.equal(result.length, 1);
    assert.equal(result[0].source, "reply");
    assert.deepEqual(result[0].content, blocks);
  });
});
