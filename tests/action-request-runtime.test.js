import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeQueuedActionRequests } from "../action-request-runtime.js";

/**
 * @returns {Session}
 */
function createSession() {
  /** @type {Message[]} */
  const persistedMessages = [];
  return /** @type {Session} */ ({
    chatId: "chat-1",
    senderIds: [],
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
    addMessage: async (_chatId, message) => {
      persistedMessages.push(message);
      return undefined;
    },
    updateToolMessage: async () => undefined,
  });
}

describe("executeQueuedActionRequests", () => {
  it("executes queued requests in filename order and returns the last tool result", async () => {
    const requestsDir = await fs.mkdtemp(path.join(os.tmpdir(), "action-requests-"));
    await fs.writeFile(
      path.join(requestsDir, "0001-generate-video.json"),
      JSON.stringify({
        kind: "whatsapp-action-request",
        action: "generate_video",
        arguments: { prompt: "teaser trailer" },
        cwd: "/repo",
      }, null, 2),
      "utf8",
    );
    await fs.writeFile(
      path.join(requestsDir, "0002-generate.json"),
      JSON.stringify({
        kind: "whatsapp-action-request",
        action: "generate_image",
        arguments: { prompt: "poster" },
        cwd: "/repo",
      }, null, 2),
      "utf8",
    );

    /** @type {Array<{ actionName: string, params: Record<string, unknown>, workdir: string | null }>} */
    const executed = [];
    /** @type {ToolContentBlock[][]} */
    const toolResults = [];
    /** @type {Message[]} */
    const messages = [];

    const result = await executeQueuedActionRequests(requestsDir, {
      toolRuntime: /** @type {ToolRuntime} */ ({
        listTools: () => [
          {
            name: "generate_video",
            description: "Generate a video",
            parameters: { type: "object", properties: {} },
            permissions: {},
            formatToolCall: ({ prompt }) => `Generating ${typeof prompt === "string" ? prompt : "video"}`,
          },
          {
            name: "generate_image",
            description: "Generate an image",
            parameters: { type: "object", properties: {} },
            permissions: {},
            formatToolCall: ({ prompt }) => `Generating ${typeof prompt === "string" ? prompt : "image"}`,
          },
        ],
        getTool: async (name) => name === "generate_video"
          ? {
              name,
            description: "Generate a video",
            parameters: { type: "object", properties: {} },
            permissions: {},
            formatToolCall: ({ prompt }) => `Generating ${typeof prompt === "string" ? prompt : "video"}`,
          }
          : {
            name,
            description: "Generate an image",
            parameters: { type: "object", properties: {} },
            permissions: {},
            formatToolCall: ({ prompt }) => `Generating ${typeof prompt === "string" ? prompt : "image"}`,
          },
        executeTool: async (actionName, _context, params, options) => {
          executed.push({ actionName, params, workdir: options.workdir ?? null });
          if (actionName === "generate_video") {
            return { result: [{ type: "text", text: "video generated" }], permissions: {} };
          }
          return { result: [{ type: "text", text: "image generated" }], permissions: {} };
        },
      }),
      session: createSession(),
      hooks: {
        onToolCall: async () => undefined,
        onToolResult: async (blocks) => {
          toolResults.push(blocks);
        },
        onToolError: async () => {},
      },
      messages,
      runConfig: undefined,
    });

    assert.deepEqual(executed, [
      {
        actionName: "generate_video",
        params: { prompt: "teaser trailer" },
        workdir: "/repo",
      },
      {
        actionName: "generate_image",
        params: { prompt: "poster" },
        workdir: "/repo",
      },
    ]);
    assert.equal(toolResults.length, 2);
    assert.deepEqual(result, [{ type: "text", text: "image generated" }]);
    assert.equal(messages.length, 2);
    assert.equal(messages[0]?.role, "tool");
    assert.equal(messages[1]?.role, "tool");
  });

  it("converts queued media-path arguments into image blocks", async () => {
    const requestsDir = await fs.mkdtemp(path.join(os.tmpdir(), "action-requests-"));
    const mediaPath = `${"a".repeat(64)}.png`;
    await fs.writeFile(
      path.join(requestsDir, "0001-generate.json"),
      JSON.stringify({
        kind: "whatsapp-action-request",
        action: "generate_image",
        arguments: {
          prompt: "edit image",
          image_paths: [mediaPath],
        },
        cwd: "/repo",
      }, null, 2),
      "utf8",
    );

    /** @type {Array<Record<string, unknown>>} */
    const executedParams = [];

    await executeQueuedActionRequests(requestsDir, {
      toolRuntime: /** @type {ToolRuntime} */ ({
        listTools: () => [{
          name: "generate_image",
          description: "Generate an image",
          parameters: { type: "object", properties: {} },
          permissions: {},
        }],
        getTool: async () => ({
          name: "generate_image",
          description: "Generate an image",
          parameters: { type: "object", properties: {} },
          permissions: {},
        }),
        executeTool: async (_actionName, _context, params) => {
          executedParams.push(params);
          return { result: [{ type: "text", text: "ok" }], permissions: {} };
        },
      }),
      session: createSession(),
      hooks: {
        onToolCall: async () => undefined,
        onToolResult: async () => {},
        onToolError: async () => {},
      },
      messages: [],
      runConfig: undefined,
    });

    assert.equal(executedParams.length, 1);
    const images = executedParams[0]?.images;
    assert.ok(Array.isArray(images));
    assert.deepEqual(images, [{
      type: "image",
      path: mediaPath,
      mime_type: "image/png",
    }]);
  });
});
