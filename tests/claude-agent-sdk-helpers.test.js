import { before, describe, it } from "node:test";
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

import { resolveMediaPath } from "../attachment-paths.js";
import { setDb } from "../db.js";
import { formatToolCallDisplay } from "../tool-display.js";
import {
  buildClaudePrompt,
  buildClaudeSystemPrompt,
  createClaudeAgentSdkHarness,
  extractToolResultText,
  extractToolResultFromEvent,
  handleSandboxEscapeApproval,
  hasTextField,
} from "../harnesses/claude-agent-sdk.js";
import { createTestDb, seedChat } from "./helpers.js";

/**
 * @param {OutboundEvent} event
 * @returns {string}
 */
function getReplyText(event) {
  assert.equal(event.kind, "content");
  return typeof event.content === "string" ? event.content : JSON.stringify(event.content);
}

before(async () => {
  const db = await createTestDb();
  setDb("./pgdata/root", db);
});

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
      { name: "permissions", description: "Show or set the Claude SDK permissions mode" },
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

  it("preserves the saved session when the SDK query hits a provider rate limit", async () => {
    /** @type {Array<HarnessSessionRef | null>} */
    const savedSessions = [];
    /** @type {string[]} */
    const toolErrors = [];
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-rate-limit-"));
    const harness = createClaudeAgentSdkHarness({
      query: () => ({
        supportedModels: async () => [],
        streamInput: async () => {},
        [Symbol.asyncIterator]: async function* () {
          throw new Error("Claude Code returned an error result: API Error: Rate limit reached");
        },
      }),
    });

    try {
      const result = await harness.run({
        session: {
          chatId: "claude-rate-limit-chat",
          senderIds: ["user-1"],
          context: /** @type {ExecuteActionContext} */ ({
            chatId: "claude-rate-limit-chat",
            senderIds: ["user-1"],
            content: [],
            getIsAdmin: async () => true,
            send: async () => undefined,
            reply: async () => undefined,
            reactToMessage: async () => {},
            select: async () => "",
            confirm: async () => true,
          }),
          addMessage: async () => /** @type {import("../store.js").MessageRow} */ ({
            message_id: 1,
            chat_id: "claude-rate-limit-chat",
            sender_id: "user-1",
            message_data: { role: "assistant", content: [] },
            timestamp: new Date().toISOString(),
            display_key: null,
          }),
          updateToolMessage: async () => undefined,
          harnessSession: { id: "sess-claude-rate-limit", kind: "claude-sdk" },
          saveHarnessSession: async (_chatId, sessionRef) => {
            savedSessions.push(sessionRef);
          },
        },
        llmConfig: {
          llmClient: /** @type {LlmClient} */ ({}),
          chatModel: null,
          externalInstructions: "",
          toolRuntime: /** @type {ToolRuntime} */ ({
            getTool: async () => null,
            executeTool: async () => {
              throw new Error("executeTool should not be called");
            },
            listTools: () => [],
          }),
        },
        messages: [{ role: "user", content: [{ type: "text", text: "Do work" }] }],
        mediaRegistry: new Map(),
        hooks: {
          onToolError: async (message) => {
            toolErrors.push(message);
          },
        },
        runConfig: { workdir },
      });

      assert.deepEqual(savedSessions, []);
      assert.ok(toolErrors.some((message) => message.includes("Rate limit reached")));
      assert.ok(result.response.some((block) => block.type === "text" && block.text.includes("Rate limit reached")));
    } finally {
      await fs.rm(workdir, { recursive: true, force: true });
    }
  });

  it("displays Write tool content when the SDK only provides the ID on the hook input", async () => {
    /** @type {SendContent[]} */
    const displays = [];
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-write-display-"));
    const filePath = path.join(workdir, "sdk-shape.js");
    const content = "export const sdkShape = 1;\n";

    const harness = createClaudeAgentSdkHarness({
      query: ({ options }) => ({
        supportedModels: async () => [],
        streamInput: async () => {},
        [Symbol.asyncIterator]: async function* () {
          const preToolHook = options.hooks?.PreToolUse?.[0]?.hooks[0];
          assert.equal(typeof preToolHook, "function");
          await preToolHook({
            hook_event_name: "PreToolUse",
            session_id: "sdk-session-1",
            transcript_path: path.join(workdir, "transcript.jsonl"),
            cwd: workdir,
            tool_name: "Write",
            tool_input: { file_path: filePath, content },
            tool_use_id: "tool-from-input",
          }, undefined, { signal: new AbortController().signal });
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            result: "",
            total_cost_usd: 0,
            usage: { input_tokens: 0, output_tokens: 0 },
            session_id: "sdk-session-1",
          };
        },
      }),
    });

    try {
      await harness.run({
        session: {
          chatId: "claude-write-display-chat",
          senderIds: ["user-1"],
          context: /** @type {ExecuteActionContext} */ ({
            chatId: "claude-write-display-chat",
            senderIds: ["user-1"],
            content: [],
            getIsAdmin: async () => true,
            send: async () => undefined,
            reply: async () => undefined,
            reactToMessage: async () => {},
            select: async () => "",
            confirm: async () => true,
          }),
          addMessage: async () => /** @type {import("../store.js").MessageRow} */ ({
            message_id: 1,
            chat_id: "claude-write-display-chat",
            sender_id: "user-1",
            message_data: { role: "assistant", content: [] },
            timestamp: new Date().toISOString(),
            display_key: null,
          }),
          updateToolMessage: async () => undefined,
          harnessSession: null,
          saveHarnessSession: async () => {},
        },
        llmConfig: {
          llmClient: /** @type {LlmClient} */ ({}),
          chatModel: null,
          externalInstructions: "",
          toolRuntime: /** @type {ToolRuntime} */ ({
            getTool: async () => null,
            executeTool: async () => {
              throw new Error("executeTool should not be called");
            },
            listTools: () => [],
          }),
        },
        messages: [{ role: "user", content: [{ type: "text", text: "Write the file" }] }],
        mediaRegistry: new Map(),
        hooks: {
          onToolCall: async (toolCall, _formatToolCall, toolContext) => {
            const display = formatToolCallDisplay(toolCall, undefined, workdir, toolContext);
            assert.ok(display);
            displays.push(display);
            return undefined;
          },
        },
        runConfig: { workdir },
      });

      assert.equal(displays.length, 1);
      const display = displays[0];
      assert.ok(Array.isArray(display));
      const block = display[0];
      assert.equal(block?.type, "code");
      assert.equal(block.code, content);
      assert.equal(block.language, "javascript");
      assert.equal(block.caption, "*Write*  `sdk-shape.js`");
    } finally {
      await fs.rm(workdir, { recursive: true, force: true });
    }
  });

  it("handles permissions command through a selector and defaults to workspace-write", async () => {
    const db = await createTestDb();
    await seedChat(db, "claude-chat-1", { enabled: true });
    const harness = createClaudeAgentSdkHarness();
    /** @type {string[]} */
    const replies = [];
    /** @type {SelectOption[] | null} */
    let selectedOptions = null;

    const handled = await harness.handleCommand({
      chatId: "claude-chat-1",
      command: "permissions",
      context: /** @type {ExecuteActionContext} */ ({
        chatId: "claude-chat-1",
        senderIds: [],
        content: [],
        getIsAdmin: async () => true,
        send: async () => undefined,
        reply: async (event) => {
          replies.push(getReplyText(event));
          return undefined;
        },
        reactToMessage: async () => {},
        select: async (_question, options) => {
          selectedOptions = options;
          return "danger-full-access";
        },
        confirm: async () => true,
      }),
    });

    const { rows: [chat] } = await db.sql`
      SELECT harness_config
      FROM chats
      WHERE chat_id = 'claude-chat-1'
    `;

    assert.equal(handled, true);
    assert.deepEqual(selectedOptions, [
      { id: "workspace-write", label: "Workspace Write" },
      { id: "read-only", label: "Read Only" },
      { id: "danger-full-access", label: "Full Access" },
    ]);
    assert.deepEqual(chat?.harness_config, {
      "claude-agent-sdk": {
        sandboxMode: "danger-full-access",
      },
    });
    assert.ok(replies.at(-1)?.includes("SDK permissions: `danger-full-access`"));
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
  it("keeps private-chat text prompts unchanged", () => {
    const prompt = buildClaudePrompt([{
      role: "user",
      content: [{
        type: "text",
        text: "hello",
      }],
    }]);

    assert.equal(prompt, "hello");
  });

  it("ignores sender metadata when building Claude prompts", () => {
    const prompt = buildClaudePrompt([{
      role: "user",
      senderName: "Marco D'Agostini",
      content: [{
        type: "text",
        text: "hello",
      }],
    }]);

    assert.equal(prompt, "hello");
  });

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

  it("includes canonical file paths for document-only user turns", () => {
    const mediaPath = `${"e".repeat(64)}.pdf`;
    const prompt = buildClaudePrompt([{
      role: "user",
      content: [{
        type: "file",
        path: mediaPath,
        mime_type: "application/pdf",
        file_name: "report.pdf",
      }],
    }]);

    assert.equal(prompt, `Attached media files:\n- file: ${mediaPath}`);
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
