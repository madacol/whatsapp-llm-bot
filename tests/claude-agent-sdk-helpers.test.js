import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// These are module-internal functions — import the module and test via
// the public function that uses them (extractToolResultText is not exported).
// We test extractToolResultFromEvent which is also not exported but exercises
// the same code paths. Since neither is exported, we test them indirectly
// through a minimal re-export helper, or we restructure.
//
// For now: extractToolResultFromEvent IS used publicly by handleUserEvent,
// but isn't exported. Let's test the logic by importing the module's internal
// functions. In this codebase, we can add targeted exports for testing.

// We'll test hasTextField and extractToolResultText by dynamically importing
// the module and checking their behavior through the module's public surface.
// Actually, these are all module-private. Let me add minimal test exports.

// Since the functions aren't exported, we'll create a test helper that
// re-exports them. But per CLAUDE.md, prefer editing existing files.
// Let's add targeted named exports for the test-relevant pure functions.

// For now, test the behavior through the module's public createClaudeAgentSdkHarness
// entry point — but that's heavy. The pragmatic solution: add exports to the module.

// The below tests assume we've added: export { extractToolResultText, extractToolResultFromEvent, hasTextField }
// to harnesses/claude-agent-sdk.js

import {
  buildClaudePrompt,
  buildClaudeSystemPrompt,
  buildClaudeWorkspaceArtifacts,
  createClaudeAgentSdkHarness,
  extractToolResultText,
  extractToolResultFromEvent,
  handleSandboxEscapeApproval,
  hasTextField,
  writeClaudeWorkspaceArtifacts,
} from "../harnesses/claude-agent-sdk.js";
import { resolveMediaPath } from "../media-store.js";

describe("createClaudeAgentSdkHarness", () => {
  it("exposes the unified harness contract", async () => {
    const harness = createClaudeAgentSdkHarness();

    assert.equal(harness.getName?.(), "claude-agent-sdk");
    assert.equal(typeof harness.run, "function");
    assert.equal(typeof harness.handleCommand, "function");
    assert.equal(typeof harness.listSlashCommands, "function");

    const capabilities = harness.getCapabilities?.();
    assert.deepEqual(capabilities, {
      supportsResume: true,
      supportsCancel: true,
      supportsLiveInput: true,
      supportsApprovals: true,
      supportsWorkdir: true,
      supportsSandboxConfig: false,
      supportsModelSelection: true,
      supportsReasoningEffort: true,
      supportsSessionFork: false,
    });
    assert.deepEqual(harness.listSlashCommands?.(), [
      { name: "clear", description: "Clear the current harness session" },
      { name: "resume", description: "Restore a previously cleared harness session" },
      { name: "model", description: "Choose or set the Claude SDK model and reasoning effort" },
    ]);
  });

  it("returns false for commands it does not own", async () => {
    const harness = createClaudeAgentSdkHarness();
    const handled = await harness.handleCommand?.({
      chatId: "chat-1",
      command: "resume",
      context: /** @type {ExecuteActionContext} */ ({
        chatId: "chat-1",
        senderIds: [],
        content: [],
        getIsAdmin: async () => true,
        send: async () => undefined,
        reply: async () => undefined,
        reactToMessage: async () => {},
        select: async () => "",
        confirm: async () => true,
      }),
    });

    assert.equal(handled, false);
  });
});

describe("buildClaudeSystemPrompt", () => {
  it("returns null when no external instructions are provided", () => {
    assert.equal(buildClaudeSystemPrompt(""), null);
    assert.equal(buildClaudeSystemPrompt("   "), null);
  });

  it("passes explicit external instructions through unchanged except trimming", () => {
    assert.equal(
      buildClaudeSystemPrompt("  Use the custom prompt.  "),
      "Use the custom prompt.",
    );
  });
});

describe("buildClaudePrompt", () => {
  it("includes canonical media paths for media-only user turns", () => {
    const mediaPath = `${"b".repeat(64)}.jpg`;
    const prompt = buildClaudePrompt([{
      role: "user",
      content: [{
        type: "image",
        path: mediaPath,
        mime_type: "image/jpeg",
      }],
    }]);

    assert.equal(prompt, `Attached media files:\n- image: ${mediaPath}`);
  });

  it("keeps user text and appends media paths when both are present", () => {
    const mediaPath = `${"c".repeat(64)}.png`;
    const prompt = buildClaudePrompt([{
      role: "user",
      content: [
        { type: "text", text: "Describe this image" },
        { type: "image", path: mediaPath, mime_type: "image/png" },
      ],
    }]);

    assert.equal(prompt, `Describe this image\n\nAttached media files:\n- image: ${mediaPath}`);
  });

  it("renders images with alt text as markdown while keeping the media path", () => {
    const mediaPath = `${"d".repeat(64)}.jpg`;
    const mediaFilePath = resolveMediaPath(mediaPath);
    const prompt = buildClaudePrompt([{
      role: "user",
      content: [
        { type: "text", text: "explain" },
        {
          type: "image",
          path: mediaPath,
          mime_type: "image/jpeg",
          alt: "Two green iguanas standing upright and leaning against each other.",
        },
      ],
    }]);

    assert.equal(
      prompt,
      `explain\n![Two green iguanas standing upright and leaning against each other.](${mediaFilePath})`,
    );
  });
});

describe("buildClaudeWorkspaceArtifacts", () => {
  it("returns no files when there are no chat-scoped actions", () => {
    const artifacts = buildClaudeWorkspaceArtifacts(/** @type {ToolRuntime} */ ({
      listTools: () => [{
        name: "Read",
        description: "Read a file",
        parameters: { type: "object", properties: {} },
        scope: "global",
      }],
      getTool: async () => null,
      executeTool: async () => ({ result: "", permissions: {} }),
    }));

    assert.deepEqual(artifacts, []);
  });

  it("builds workspace files for chat-scoped actions only", () => {
    const artifacts = buildClaudeWorkspaceArtifacts(/** @type {ToolRuntime} */ ({
      listTools: () => [
        {
          name: "remind",
          description: "Schedule a reminder",
          parameters: {
            type: "object",
            properties: { when: { type: "string" } },
          },
          scope: "chat",
        },
        {
          name: "Read",
          description: "Read a file",
          parameters: { type: "object", properties: {} },
          scope: "global",
        },
      ],
      getTool: async () => null,
      executeTool: async () => ({ result: "", permissions: {} }),
    }));

    assert.equal(artifacts.length, 2);
    assert.ok(artifacts[0]?.relativePath.endsWith(".madabot/chat-actions.json"));
    assert.ok(artifacts[1]?.relativePath.endsWith(".madabot/chat-actions.md"));
    assert.ok(artifacts[0]?.content.includes("\"name\": \"remind\""));
    assert.ok(!artifacts[0]?.content.includes("\"name\": \"Read\""));
    assert.ok(artifacts[1]?.content.includes("## remind"));
  });
});

describe("writeClaudeWorkspaceArtifacts", () => {
  it("writes chat action files into .madabot", async () => {
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-sdk-artifacts-"));
    await writeClaudeWorkspaceArtifacts(workdir, /** @type {ToolRuntime} */ ({
      listTools: () => [{
        name: "remind",
        description: "Schedule a reminder",
        parameters: {
          type: "object",
          properties: { when: { type: "string" } },
        },
        scope: "chat",
      }],
      getTool: async () => null,
      executeTool: async () => ({ result: "", permissions: {} }),
    }));

    const jsonText = await fs.readFile(path.join(workdir, ".madabot/chat-actions.json"), "utf8");
    const markdownText = await fs.readFile(path.join(workdir, ".madabot/chat-actions.md"), "utf8");

    assert.ok(jsonText.includes("\"name\": \"remind\""));
    assert.ok(markdownText.includes("## remind"));
  });
});

// ── hasTextField ──

describe("hasTextField", () => {
  it("returns true for { text: string }", () => {
    assert.equal(hasTextField({ text: "hello" }), true);
  });

  it("returns true for empty string text", () => {
    assert.equal(hasTextField({ text: "" }), true);
  });

  it("returns false for null", () => {
    assert.equal(hasTextField(null), false);
  });

  it("returns false for undefined", () => {
    assert.equal(hasTextField(undefined), false);
  });

  it("returns false for string (not an object)", () => {
    assert.equal(hasTextField("hello"), false);
  });

  it("returns false for object without text", () => {
    assert.equal(hasTextField({ name: "x" }), false);
  });

  it("returns false for object with non-string text", () => {
    assert.equal(hasTextField({ text: 42 }), false);
    assert.equal(hasTextField({ text: null }), false);
    assert.equal(hasTextField({ text: true }), false);
  });
});

// ── extractToolResultText ──

describe("extractToolResultText", () => {
  it("returns string input directly", () => {
    assert.equal(extractToolResultText("hello"), "hello");
  });

  it("extracts text from array of content blocks", () => {
    const blocks = [
      { type: "text", text: "line 1" },
      { type: "text", text: "line 2" },
    ];
    assert.equal(extractToolResultText(blocks), "line 1\nline 2");
  });

  it("filters out non-text blocks from array", () => {
    const blocks = [
      { type: "text", text: "keep" },
      { type: "image", data: "..." },
      null,
      42,
    ];
    assert.equal(extractToolResultText(blocks), "keep");
  });

  it("extracts text from single content block object", () => {
    assert.equal(extractToolResultText({ text: "solo" }), "solo");
  });

  it("falls back to JSON for unknown objects", () => {
    const obj = { foo: "bar" };
    assert.equal(extractToolResultText(obj), JSON.stringify(obj, null, 2));
  });

  it("falls back to String for non-serializable values", () => {
    // BigInt is not JSON-serializable
    const val = BigInt(42);
    assert.equal(extractToolResultText(val), "42");
  });

  it("returns empty array as JSON", () => {
    assert.equal(extractToolResultText([]), "[]");
  });
});

// ── extractToolResultFromEvent ──

describe("extractToolResultFromEvent", () => {
  it("falls back to parent_tool_use_id when no content block ID exists", () => {
    const event = {
      type: "user",
      parent_tool_use_id: "tool-123",
      message: { role: "user", content: "result text" },
      session_id: "s1",
    };
    const { toolUseId } = extractToolResultFromEvent(event);
    assert.equal(toolUseId, "tool-123");
  });

  it("extracts resultText from tool_use_result string", () => {
    const event = {
      type: "user",
      parent_tool_use_id: "tool-1",
      tool_use_result: "the result",
      message: { role: "user", content: "" },
      session_id: "s1",
    };
    const { resultText } = extractToolResultFromEvent(event);
    assert.equal(resultText, "the result");
  });

  it("extracts toolUseId from message.content tool_result blocks when parent_tool_use_id is null", () => {
    const event = {
      type: "user",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool-456", content: "block result" },
        ],
      },
      session_id: "s1",
    };
    const { toolUseId, resultText } = extractToolResultFromEvent(event);
    assert.equal(toolUseId, "tool-456");
    assert.equal(resultText, "block result");
  });

  it("prefers content block tool_use_id over parent_tool_use_id (sub-agent fix)", () => {
    // Sub-agent events have parent_tool_use_id pointing to the Agent tool call,
    // but the content block has the individual tool call ID we actually need.
    const event = {
      type: "user",
      parent_tool_use_id: "agent-tool-999",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "bash-456", content: "command output" },
        ],
      },
      session_id: "s1",
    };
    const { toolUseId, resultText } = extractToolResultFromEvent(event);
    assert.equal(toolUseId, "bash-456", "should use content block ID, not parent_tool_use_id");
    assert.equal(resultText, "command output");
  });

  it("extracts text from nested content array in tool_result block", () => {
    const event = {
      type: "user",
      parent_tool_use_id: "tool-1",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: [{ type: "text", text: "nested text" }],
          },
        ],
      },
      session_id: "s1",
    };
    const { resultText } = extractToolResultFromEvent(event);
    assert.equal(resultText, "nested text");
  });

  it("stringifies structured tool_result block content when no text blocks are present", () => {
    const event = {
      type: "user",
      parent_tool_use_id: "tool-1",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: {
              stdout: "line 1\nline 2",
              stderr: "",
              exit_code: 0,
            },
          },
        ],
      },
      session_id: "s1",
    };
    const { resultText } = extractToolResultFromEvent(event);
    assert.equal(resultText, JSON.stringify({
      stdout: "line 1\nline 2",
      stderr: "",
      exit_code: 0,
    }, null, 2));
  });

  it("returns null toolUseId and resultText when message has no content", () => {
    const event = {
      type: "user",
      parent_tool_use_id: null,
      message: { role: "user", content: "" },
      session_id: "s1",
    };
    const { toolUseId, resultText } = extractToolResultFromEvent(event);
    assert.equal(toolUseId, null);
    assert.equal(resultText, null);
  });

  it("extracts resultText from string message.content", () => {
    const event = {
      type: "user",
      parent_tool_use_id: "tool-1",
      message: { role: "user", content: "direct string" },
      session_id: "s1",
    };
    const { resultText } = extractToolResultFromEvent(event);
    assert.equal(resultText, "direct string");
  });

  it("sub-agent event with tool_use_result but no content blocks uses parent_tool_use_id", () => {
    // When no content block provides a tool_use_id, fall back to parent_tool_use_id
    const event = {
      type: "user",
      parent_tool_use_id: "agent-tool-999",
      tool_use_result: "some output",
      message: { role: "user", content: "" },
      session_id: "s1",
    };
    const { toolUseId, resultText } = extractToolResultFromEvent(event);
    assert.equal(toolUseId, "agent-tool-999");
    assert.equal(resultText, "some output");
  });
});

describe("handleSandboxEscapeApproval", () => {
  it("denies the tool call when the user rejects the sandbox escape", async () => {
    const result = await handleSandboxEscapeApproval({
      toolName: "Bash",
      kind: "command",
      summary: "Run a shell command that targets `/tmp` outside the workspace `/repo`.",
      command: "ls /tmp",
      target: "/tmp",
      workdir: "/repo",
    }, { command: "ls /tmp" }, async () => "❌ Deny");

    assert.deepEqual(result, {
      behavior: "deny",
      message: "User denied sandbox escape for Bash.",
    });
  });

  it("preserves the original SDK input when the user allows the sandbox escape", async () => {
    const input = { command: "ls /tmp" };
    const result = await handleSandboxEscapeApproval({
      toolName: "Bash",
      kind: "command",
      summary: "Run a shell command that targets `/tmp` outside the workspace `/repo`.",
      command: "ls /tmp",
      target: "/tmp",
      workdir: "/repo",
    }, input, async () => "✅ Allow");

    assert.deepEqual(result, {
      behavior: "allow",
      updatedInput: input,
    });
  });
});
