import assert from "node:assert/strict";
import config from "../../config.js";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

/** @type {number} */
let pollIntervalMs = 10_000;

/** @type {number} */
let maxPollAttempts = 60;

export default /** @type {defineAction} */ ((x) => x)({
  name: "generate_video",
  description:
    "Generate a video from a text prompt using AI (Google Veo 3). Supports aspect ratio, duration, resolution, and negative prompt parameters.",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "Text description of the video to generate",
      },
      aspect_ratio: {
        type: "string",
        description: "Aspect ratio (e.g. '16:9', '9:16'). Defaults to '16:9'",
      },
      duration_seconds: {
        type: "number",
        description: "Duration in seconds (5 or 8). Defaults to 5",
      },
      negative_prompt: {
        type: "string",
        description: "Things to avoid in the generated video",
      },
    },
    required: ["prompt"],
  },
  permissions: {
    autoExecute: true,
    autoContinue: false,
  },
  test_functions: [
    async function test_generates_video_from_prompt(action_fn) {
      const originalFetch = globalThis.fetch;
      /** @type {Array<{video: Buffer, caption?: string}>} */
      const sentVideos = [];
      const videoBase64 = Buffer.from("fake-video-data").toString("base64");
      try {
        let fetchCallCount = 0;
        globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (
          async (/** @type {string} */ url) => {
            fetchCallCount++;
            // Call 1: POST to start generation
            if (fetchCallCount === 1) {
              return {
                ok: true,
                json: async () => ({ name: "operations/op-123" }),
              };
            }
            // Call 2: Poll — done
            if (fetchCallCount === 2) {
              return {
                ok: true,
                json: async () => ({
                  done: true,
                  response: {
                    generateVideoResponse: {
                      generatedSamples: [{
                        video: { uri: "https://example.com/video.mp4" },
                      }],
                    },
                  },
                }),
              };
            }
            // Call 3: Download video
            return {
              ok: true,
              arrayBuffer: async () => Buffer.from("fake-video-data").buffer,
            };
          }
        ));

        const savedPollInterval = pollIntervalMs;
        pollIntervalMs = 0;
        try {
          const result = await action_fn(
            {
              content: [{ type: "text", text: "a flying car" }],
              sendVideo: async (/** @type {Buffer} */ video, /** @type {string | undefined} */ caption) => {
                sentVideos.push({ video, caption });
              },
              log: async () => "",
            },
            { prompt: "a flying car" },
          );

          assert.equal(sentVideos.length, 1);
          assert.ok(Buffer.isBuffer(sentVideos[0].video));
          // Returns ActionSignal with content blocks
          assert.equal(result.autoContinue, false);
          assert.ok(Array.isArray(result.result));
          const blocks = /** @type {ToolContentBlock[]} */ (result.result);
          assert.ok(blocks.some((b) => b.type === "text"));
          assert.ok(blocks.some((b) => b.type === "video"));
        } finally {
          pollIntervalMs = savedPollInterval;
        }
      } finally {
        globalThis.fetch = originalFetch;
      }
    },

    async function test_passes_all_parameters(action_fn) {
      const originalFetch = globalThis.fetch;
      /** @type {unknown} */
      let capturedBody;
      const videoBase64 = Buffer.from("fake-video").toString("base64");
      try {
        let fetchCallCount = 0;
        globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (
          async (/** @type {string} */ url, /** @type {RequestInit | undefined} */ init) => {
            fetchCallCount++;
            if (fetchCallCount === 1) {
              capturedBody = JSON.parse(/** @type {string} */ (init?.body));
              return {
                ok: true,
                json: async () => ({ name: "operations/op-456" }),
              };
            }
            if (fetchCallCount === 2) {
              return {
                ok: true,
                json: async () => ({
                  done: true,
                  response: {
                    generateVideoResponse: {
                      generatedSamples: [{
                        video: { uri: "https://example.com/video.mp4" },
                      }],
                    },
                  },
                }),
              };
            }
            return {
              ok: true,
              arrayBuffer: async () => Buffer.from("fake-video").buffer,
            };
          }
        ));

        const savedPollInterval = pollIntervalMs;
        pollIntervalMs = 0;
        try {
          await action_fn(
            {
              content: [{ type: "text", text: "test" }],
              sendVideo: async () => {},
              log: async () => "",
            },
            {
              prompt: "a sunset over the ocean",
              aspect_ratio: "9:16",
              duration_seconds: 8,
              negative_prompt: "blurry, low quality",
            },
          );

          const body = /** @type {{instances: Array<{prompt: string}>, parameters: Record<string, unknown>}} */ (capturedBody);
          assert.equal(body.instances[0].prompt, "a sunset over the ocean");
          assert.equal(body.parameters.aspectRatio, "9:16");
          assert.equal(body.parameters.durationSeconds, 8);
          assert.equal(body.parameters.negativePrompt, "blurry, low quality");
        } finally {
          pollIntervalMs = savedPollInterval;
        }
      } finally {
        globalThis.fetch = originalFetch;
      }
    },

    async function test_handles_api_error(action_fn) {
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (
          async () => ({
            ok: false,
            status: 403,
            text: async () => "Forbidden",
          })
        ));

        const result = await action_fn(
          {
            content: [{ type: "text", text: "test" }],
            sendVideo: async () => {},
            log: async () => "",
          },
          { prompt: "test" },
        );

        assert.ok(typeof result === "string");
        assert.ok(result.includes("403"));
      } finally {
        globalThis.fetch = originalFetch;
      }
    },

    async function test_handles_polling_timeout(action_fn) {
      const originalFetch = globalThis.fetch;
      try {
        let fetchCallCount = 0;
        globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (
          async () => {
            fetchCallCount++;
            if (fetchCallCount === 1) {
              return {
                ok: true,
                json: async () => ({ name: "operations/op-timeout" }),
              };
            }
            // Always return not done
            return {
              ok: true,
              json: async () => ({ done: false }),
            };
          }
        ));

        const savedPollInterval = pollIntervalMs;
        const savedMaxAttempts = maxPollAttempts;
        pollIntervalMs = 0;
        maxPollAttempts = 2;
        try {
          const result = await action_fn(
            {
              content: [{ type: "text", text: "test" }],
              sendVideo: async () => {},
              log: async () => "",
            },
            { prompt: "test" },
          );

          assert.ok(typeof result === "string");
          assert.ok(result.toLowerCase().includes("timeout") || result.toLowerCase().includes("timed out"));
        } finally {
          pollIntervalMs = savedPollInterval;
          maxPollAttempts = savedMaxAttempts;
        }
      } finally {
        globalThis.fetch = originalFetch;
      }
    },

    async function test_handles_no_video_in_response(action_fn) {
      const originalFetch = globalThis.fetch;
      try {
        let fetchCallCount = 0;
        globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (
          async () => {
            fetchCallCount++;
            if (fetchCallCount === 1) {
              return {
                ok: true,
                json: async () => ({ name: "operations/op-empty" }),
              };
            }
            return {
              ok: true,
              json: async () => ({
                done: true,
                response: {
                  generateVideoResponse: {
                    generatedSamples: [],
                  },
                },
              }),
            };
          }
        ));

        const savedPollInterval = pollIntervalMs;
        pollIntervalMs = 0;
        try {
          const result = await action_fn(
            {
              content: [{ type: "text", text: "test" }],
              sendVideo: async () => {},
              log: async () => "",
            },
            { prompt: "test" },
          );

          assert.ok(typeof result === "string");
          assert.ok(result.toLowerCase().includes("no video") || result.toLowerCase().includes("did not generate"));
        } finally {
          pollIntervalMs = savedPollInterval;
        }
      } finally {
        globalThis.fetch = originalFetch;
      }
    },

    async function test_returns_error_when_no_gemini_api_key(action_fn) {
      const saved = process.env.GEMINI_API_KEY;
      try {
        delete process.env.GEMINI_API_KEY;

        const result = await action_fn(
          {
            content: [{ type: "text", text: "test" }],
            sendVideo: async () => {},
            log: async () => "",
          },
          { prompt: "test" },
        );

        assert.ok(typeof result === "string");
        assert.ok(result.includes("GEMINI_API_KEY"));
      } finally {
        if (saved !== undefined) {
          process.env.GEMINI_API_KEY = saved;
        } else {
          delete process.env.GEMINI_API_KEY;
        }
      }
    },
  ],
  /**
   * @param {ActionContext} context
   * @param {{ prompt: string, aspect_ratio?: string, duration_seconds?: number, negative_prompt?: string }} params
   */
  action_fn: async function (context, params) {
    return "not implemented";
  },
});
