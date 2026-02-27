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
    "Generate a video from a text prompt using AI (Google Veo 3). Optionally include a reference image for image-to-video generation. Supports aspect ratio, duration, and negative prompt parameters.",
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
      const savedKey = process.env.GEMINI_API_KEY;
      process.env.GEMINI_API_KEY = "test-key";
      /** @type {Array<{video: Buffer, caption?: string}>} */
      const sentVideos = [];
      try {
        let fetchCallCount = 0;
        globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (
          async (/** @type {string} */ _url) => {
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
        if (savedKey !== undefined) process.env.GEMINI_API_KEY = savedKey;
        else delete process.env.GEMINI_API_KEY;
      }
    },

    async function test_passes_all_parameters(action_fn) {
      const originalFetch = globalThis.fetch;
      const savedKey = process.env.GEMINI_API_KEY;
      process.env.GEMINI_API_KEY = "test-key";
      /** @type {unknown} */
      let capturedBody;
      try {
        let fetchCallCount = 0;
        globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (
          async (/** @type {string} */ _url, /** @type {RequestInit | undefined} */ init) => {
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
        if (savedKey !== undefined) process.env.GEMINI_API_KEY = savedKey;
        else delete process.env.GEMINI_API_KEY;
      }
    },

    async function test_handles_api_error(action_fn) {
      const originalFetch = globalThis.fetch;
      const savedKey = process.env.GEMINI_API_KEY;
      process.env.GEMINI_API_KEY = "test-key";
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
        if (savedKey !== undefined) process.env.GEMINI_API_KEY = savedKey;
        else delete process.env.GEMINI_API_KEY;
      }
    },

    async function test_handles_polling_timeout(action_fn) {
      const originalFetch = globalThis.fetch;
      const savedKey = process.env.GEMINI_API_KEY;
      process.env.GEMINI_API_KEY = "test-key";
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
        if (savedKey !== undefined) process.env.GEMINI_API_KEY = savedKey;
        else delete process.env.GEMINI_API_KEY;
      }
    },

    async function test_handles_no_video_in_response(action_fn) {
      const originalFetch = globalThis.fetch;
      const savedKey = process.env.GEMINI_API_KEY;
      process.env.GEMINI_API_KEY = "test-key";
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
        if (savedKey !== undefined) process.env.GEMINI_API_KEY = savedKey;
        else delete process.env.GEMINI_API_KEY;
      }
    },

    async function test_download_includes_api_key(action_fn) {
      const originalFetch = globalThis.fetch;
      const savedKey = process.env.GEMINI_API_KEY;
      process.env.GEMINI_API_KEY = "test-key-download";
      /** @type {string | undefined} */
      let downloadApiKey;
      try {
        let fetchCallCount = 0;
        globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (
          async (/** @type {string} */ _url, /** @type {RequestInit | undefined} */ init) => {
            fetchCallCount++;
            if (fetchCallCount === 1) {
              return { ok: true, json: async () => ({ name: "operations/op-dl" }) };
            }
            if (fetchCallCount === 2) {
              return {
                ok: true,
                json: async () => ({
                  done: true,
                  response: {
                    generateVideoResponse: {
                      generatedSamples: [{ video: { uri: "https://example.com/video.mp4" } }],
                    },
                  },
                }),
              };
            }
            // Call 3: Download — capture the API key header
            const headers = /** @type {Record<string, string>} */ (init?.headers ?? {});
            downloadApiKey = headers["x-goog-api-key"];
            return { ok: true, arrayBuffer: async () => Buffer.from("video").buffer };
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
            { prompt: "test" },
          );
          assert.equal(downloadApiKey, "test-key-download");
        } finally {
          pollIntervalMs = savedPollInterval;
        }
      } finally {
        globalThis.fetch = originalFetch;
        if (savedKey !== undefined) process.env.GEMINI_API_KEY = savedKey;
        else delete process.env.GEMINI_API_KEY;
      }
    },

    async function test_sends_image_as_reference(action_fn) {
      const originalFetch = globalThis.fetch;
      const savedKey = process.env.GEMINI_API_KEY;
      process.env.GEMINI_API_KEY = "test-key";
      /** @type {unknown} */
      let capturedBody;
      try {
        let fetchCallCount = 0;
        globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (
          async (/** @type {string} */ _url, /** @type {RequestInit | undefined} */ init) => {
            fetchCallCount++;
            if (fetchCallCount === 1) {
              capturedBody = JSON.parse(/** @type {string} */ (init?.body));
              return { ok: true, json: async () => ({ name: "operations/op-img" }) };
            }
            if (fetchCallCount === 2) {
              return {
                ok: true,
                json: async () => ({
                  done: true,
                  response: {
                    generateVideoResponse: {
                      generatedSamples: [{ video: { uri: "https://example.com/video.mp4" } }],
                    },
                  },
                }),
              };
            }
            return { ok: true, arrayBuffer: async () => Buffer.from("fake-video").buffer };
          }
        ));

        const savedPollInterval = pollIntervalMs;
        pollIntervalMs = 0;
        try {
          await action_fn(
            {
              content: [
                { type: "text", text: "animate this" },
                { type: "image", encoding: "base64", mime_type: "image/jpeg", data: "aW1hZ2VkYXRh" },
              ],
              sendVideo: async () => {},
              log: async () => "",
            },
            { prompt: "animate this" },
          );

          const body = /** @type {{instances: Array<{prompt: string, image?: {bytesBase64Encoded: string, mimeType: string}}>}} */ (capturedBody);
          assert.ok(body.instances[0].image, "image should be present in instance");
          assert.equal(body.instances[0].image.bytesBase64Encoded, "aW1hZ2VkYXRh");
          assert.equal(body.instances[0].image.mimeType, "image/jpeg");
        } finally {
          pollIntervalMs = savedPollInterval;
        }
      } finally {
        globalThis.fetch = originalFetch;
        if (savedKey !== undefined) process.env.GEMINI_API_KEY = savedKey;
        else delete process.env.GEMINI_API_KEY;
      }
    },

    async function test_text_only_when_no_image(action_fn) {
      const originalFetch = globalThis.fetch;
      const savedKey = process.env.GEMINI_API_KEY;
      process.env.GEMINI_API_KEY = "test-key";
      /** @type {unknown} */
      let capturedBody;
      try {
        let fetchCallCount = 0;
        globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (
          async (/** @type {string} */ _url, /** @type {RequestInit | undefined} */ init) => {
            fetchCallCount++;
            if (fetchCallCount === 1) {
              capturedBody = JSON.parse(/** @type {string} */ (init?.body));
              return { ok: true, json: async () => ({ name: "operations/op-txt" }) };
            }
            if (fetchCallCount === 2) {
              return {
                ok: true,
                json: async () => ({
                  done: true,
                  response: {
                    generateVideoResponse: {
                      generatedSamples: [{ video: { uri: "https://example.com/video.mp4" } }],
                    },
                  },
                }),
              };
            }
            return { ok: true, arrayBuffer: async () => Buffer.from("fake-video").buffer };
          }
        ));

        const savedPollInterval = pollIntervalMs;
        pollIntervalMs = 0;
        try {
          await action_fn(
            {
              content: [{ type: "text", text: "a flying car" }],
              sendVideo: async () => {},
              log: async () => "",
            },
            { prompt: "a flying car" },
          );

          const body = /** @type {{instances: Array<{prompt: string, image?: unknown}>}} */ (capturedBody);
          assert.equal(body.instances[0].image, undefined, "image should not be present for text-only");
        } finally {
          pollIntervalMs = savedPollInterval;
        }
      } finally {
        globalThis.fetch = originalFetch;
        if (savedKey !== undefined) process.env.GEMINI_API_KEY = savedKey;
        else delete process.env.GEMINI_API_KEY;
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
    const apiKey = config.gemini_api_key;
    if (!apiKey) {
      return "Error: GEMINI_API_KEY must be configured to generate videos.";
    }

    await context.log(`Generating video: ${params.prompt}`);

    // 1. Start long-running generation
    const model = "veo-3.1-generate-preview";
    const startUrl = `${GEMINI_BASE}/models/${model}:predictLongRunning`;

    /** @type {Record<string, unknown>} */
    const parameters = {};
    if (params.aspect_ratio) parameters.aspectRatio = params.aspect_ratio;
    if (params.duration_seconds) parameters.durationSeconds = params.duration_seconds;
    if (params.negative_prompt) parameters.negativePrompt = params.negative_prompt;

    /** @type {{prompt: string, image?: {bytesBase64Encoded: string, mimeType: string}}} */
    const instance = { prompt: params.prompt };

    const image = context.content.find(
      /** @returns {block is ImageContentBlock} */
      (block) => block.type === "image",
    );
    if (image) {
      instance.image = {
        bytesBase64Encoded: image.data, mimeType: image.mime_type,
      };
    }

    const startResponse = await fetch(startUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        instances: [instance],
        parameters,
      }),
    });

    if (!startResponse.ok) {
      const errorText = await startResponse.text();
      return `Error: Veo API returned status ${startResponse.status}: ${errorText}`;
    }

    const startData = await startResponse.json();
    const operationName = startData.name;

    // 2. Poll for completion
    let attempts = 0;
    while (attempts < maxPollAttempts) {
      if (pollIntervalMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }

      const pollUrl = `${GEMINI_BASE}/${operationName}`;
      const pollResponse = await fetch(pollUrl, {
        headers: { "x-goog-api-key": apiKey },
      });

      if (!pollResponse.ok) {
        const errorText = await pollResponse.text();
        return `Error: Polling failed with status ${pollResponse.status}: ${errorText}`;
      }

      const pollData = await pollResponse.json();

      if (pollData.done) {
        const samples = pollData.response?.generateVideoResponse?.generatedSamples;
        if (!samples || samples.length === 0) {
          return "The model did not generate any video.";
        }

        const videoUri = samples[0].video.uri;
        console.log("Video URI:", videoUri);

        // 3. Download the video
        const downloadResponse = await fetch(videoUri, {
          headers: { "x-goog-api-key": apiKey },
        });
        if (!downloadResponse.ok) {
          return `Error: Failed to download video (status ${downloadResponse.status}). URL: ${videoUri}`;
        }

        const arrayBuffer = await downloadResponse.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        const caption = `Generated video: ${params.prompt}`;
        await context.sendVideo(buffer, caption);

        const base64 = buffer.toString("base64");

        /** @type {ToolContentBlock[]} */
        const contentBlocks = [
          { type: "text", text: caption },
          { type: "video", encoding: "base64", data: base64 },
        ];

        return /** @type {ActionSignal} */ ({
          result: contentBlocks,
          autoContinue: false,
        });
      }

      attempts++;
    }

    return "Error: Video generation timed out after polling.";
  },
});
