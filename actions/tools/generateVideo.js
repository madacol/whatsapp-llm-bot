import assert from "node:assert/strict";
import config from "../../config.js";
import { createLogger } from "../../logger.js";

const log = createLogger("generateVideo");

/** @type {number} */
let pollIntervalMs = 10_000;

/** @type {number} */
let maxPollAttempts = 60;

// ── fal.ai helpers (mutable for test mocking) ──

/**
 * @typedef {{ statusUrl: string, responseUrl: string }} SubmitResult
 * @typedef {{ url: string, content_type: string }} FalVideo
 * @typedef {{ video: FalVideo }} FalResult
 */

/**
 * Submit a job to fal.ai queue.
 * @param {string} endpoint - fal.ai model endpoint (e.g. "fal-ai/kling-video/v3/standard/text-to-video")
 * @param {Record<string, unknown>} input
 * @param {string} apiKey
 * @returns {Promise<SubmitResult>}
 */
let submitJob = async (endpoint, input, apiKey) => {
  const res = await fetch(`https://queue.fal.run/${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Key ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`fal.ai submit failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  return { statusUrl: data.status_url, responseUrl: data.response_url };
};

/**
 * Poll a fal.ai job until COMPLETED or timeout.
 * @param {string} statusUrl
 * @param {string} apiKey
 * @returns {Promise<void>}
 */
let pollJob = async (statusUrl, apiKey) => {
  for (let i = 0; i < maxPollAttempts; i++) {
    if (pollIntervalMs > 0) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    const res = await fetch(statusUrl, {
      headers: { Authorization: `Key ${apiKey}` },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`fal.ai poll failed (${res.status}): ${text}`);
    }
    const data = await res.json();
    if (data.status === "COMPLETED") return;
    if (data.status !== "IN_QUEUE" && data.status !== "IN_PROGRESS") {
      throw new Error(`fal.ai unexpected status: ${data.status}`);
    }
  }
  throw new Error("Video generation timed out after polling.");
};

/**
 * Get result from a completed fal.ai job.
 * @param {string} responseUrl
 * @param {string} apiKey
 * @returns {Promise<FalResult>}
 */
let getResult = async (responseUrl, apiKey) => {
  const res = await fetch(responseUrl, {
    headers: { Authorization: `Key ${apiKey}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`fal.ai result fetch failed (${res.status}): ${text}`);
  }
  return res.json();
};

/**
 * Upload an image to fal.ai CDN for image-to-video.
 * @param {string} base64Data - base64-encoded image bytes
 * @param {string} mimeType - e.g. "image/jpeg"
 * @param {string} apiKey
 * @returns {Promise<string>} The CDN file URL
 */
let uploadImage = async (base64Data, mimeType, apiKey) => {
  const ext = mimeType.split("/")[1] || "bin";
  const initRes = await fetch(
    "https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3",
    {
      method: "POST",
      headers: {
        Authorization: `Key ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content_type: mimeType, file_name: `input.${ext}` }),
    },
  );
  if (!initRes.ok) {
    const text = await initRes.text();
    throw new Error(`fal.ai upload initiate failed (${initRes.status}): ${text}`);
  }
  const { file_url, upload_url } = await initRes.json();

  const buf = Buffer.from(base64Data, "base64");
  const putRes = await fetch(upload_url, {
    method: "PUT",
    headers: { "Content-Type": mimeType },
    body: buf,
  });
  if (!putRes.ok) {
    const text = await putRes.text();
    throw new Error(`fal.ai upload PUT failed (${putRes.status}): ${text}`);
  }

  return file_url;
};

export default /** @type {defineAction} */ ((x) => x)({
  name: "generate_video",
  description:
    "Generate a video from a text prompt using AI (fal.ai, configurable model). Optionally include a reference image for image-to-video generation. Supports aspect ratio, duration, and negative prompt parameters.",
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
        description: "Duration in seconds (5 or 10). Defaults to 5",
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
      const saved = { submitJob, pollJob, getResult, uploadImage, key: process.env.FAL_KEY };
      process.env.FAL_KEY = "test-key";
      /** @type {Array<{video: Buffer, caption?: string}>} */
      const sentVideos = [];
      try {
        submitJob = async () => ({ statusUrl: "s", responseUrl: "r" });
        pollJob = async () => {};
        getResult = async () => ({ video: { url: "https://example.com/v.mp4", content_type: "video/mp4" } });

        const originalFetch = globalThis.fetch;
        globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (
          async () => ({ ok: true, arrayBuffer: async () => Buffer.from("fake-video-data").buffer })
        ));
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
          assert.equal(result.autoContinue, false);
          assert.ok(Array.isArray(result.result));
          const blocks = /** @type {ToolContentBlock[]} */ (result.result);
          assert.ok(blocks.some((b) => b.type === "text"));
          assert.ok(blocks.some((b) => b.type === "video"));
        } finally {
          globalThis.fetch = originalFetch;
        }
      } finally {
        ({ submitJob, pollJob, getResult, uploadImage } = saved);
        if (saved.key !== undefined) process.env.FAL_KEY = saved.key;
        else delete process.env.FAL_KEY;
      }
    },

    async function test_passes_all_parameters(action_fn) {
      const saved = { submitJob, pollJob, getResult, uploadImage, key: process.env.FAL_KEY };
      process.env.FAL_KEY = "test-key";
      /** @type {{ endpoint: string, input: Record<string, unknown> } | undefined} */
      let captured;
      try {
        submitJob = async (endpoint, input) => {
          captured = { endpoint, input };
          return { statusUrl: "s", responseUrl: "r" };
        };
        pollJob = async () => {};
        getResult = async () => ({ video: { url: "https://example.com/v.mp4", content_type: "video/mp4" } });

        const originalFetch = globalThis.fetch;
        globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (
          async () => ({ ok: true, arrayBuffer: async () => Buffer.from("fake-video").buffer })
        ));
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

          assert.ok(captured);
          assert.equal(captured.input.prompt, "a sunset over the ocean");
          assert.equal(captured.input.aspect_ratio, "9:16");
          assert.equal(captured.input.duration, "8");
          assert.equal(captured.input.negative_prompt, "blurry, low quality");
          assert.ok(captured.endpoint.endsWith("/text-to-video"));
        } finally {
          globalThis.fetch = originalFetch;
        }
      } finally {
        ({ submitJob, pollJob, getResult, uploadImage } = saved);
        if (saved.key !== undefined) process.env.FAL_KEY = saved.key;
        else delete process.env.FAL_KEY;
      }
    },

    async function test_handles_api_error(action_fn) {
      const saved = { submitJob, pollJob, getResult, uploadImage, key: process.env.FAL_KEY };
      process.env.FAL_KEY = "test-key";
      try {
        submitJob = async () => { throw new Error("fal.ai submit failed (403): Forbidden"); };

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
        ({ submitJob, pollJob, getResult, uploadImage } = saved);
        if (saved.key !== undefined) process.env.FAL_KEY = saved.key;
        else delete process.env.FAL_KEY;
      }
    },

    async function test_handles_no_video(action_fn) {
      const saved = { submitJob, pollJob, getResult, uploadImage, key: process.env.FAL_KEY };
      process.env.FAL_KEY = "test-key";
      try {
        submitJob = async () => ({ statusUrl: "s", responseUrl: "r" });
        pollJob = async () => {};
        getResult = async () => /** @type {FalResult} */ (/** @type {unknown} */ ({}));

        const result = await action_fn(
          {
            content: [{ type: "text", text: "test" }],
            sendVideo: async () => {},
            log: async () => "",
          },
          { prompt: "test" },
        );

        assert.ok(typeof result === "string");
        assert.ok(result.toLowerCase().includes("no video"));
      } finally {
        ({ submitJob, pollJob, getResult, uploadImage } = saved);
        if (saved.key !== undefined) process.env.FAL_KEY = saved.key;
        else delete process.env.FAL_KEY;
      }
    },

    async function test_sends_image_as_reference(action_fn) {
      const saved = { submitJob, pollJob, getResult, uploadImage, key: process.env.FAL_KEY };
      process.env.FAL_KEY = "test-key";
      /** @type {{ endpoint: string, input: Record<string, unknown> } | undefined} */
      let captured;
      let uploadCalled = false;
      try {
        uploadImage = async () => { uploadCalled = true; return "https://cdn.fal.ai/uploaded.jpg"; };
        submitJob = async (endpoint, input) => {
          captured = { endpoint, input };
          return { statusUrl: "s", responseUrl: "r" };
        };
        pollJob = async () => {};
        getResult = async () => ({ video: { url: "https://example.com/v.mp4", content_type: "video/mp4" } });

        const originalFetch = globalThis.fetch;
        globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (
          async () => ({ ok: true, arrayBuffer: async () => Buffer.from("fake-video").buffer })
        ));
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

          assert.ok(uploadCalled, "uploadImage should have been called");
          assert.ok(captured);
          assert.ok(captured.endpoint.endsWith("/image-to-video"));
          assert.equal(captured.input.start_image_url, "https://cdn.fal.ai/uploaded.jpg");
        } finally {
          globalThis.fetch = originalFetch;
        }
      } finally {
        ({ submitJob, pollJob, getResult, uploadImage } = saved);
        if (saved.key !== undefined) process.env.FAL_KEY = saved.key;
        else delete process.env.FAL_KEY;
      }
    },

    async function test_sends_quoted_image(action_fn) {
      const saved = { submitJob, pollJob, getResult, uploadImage, key: process.env.FAL_KEY };
      process.env.FAL_KEY = "test-key";
      /** @type {{ endpoint: string, input: Record<string, unknown> } | undefined} */
      let captured;
      let uploadCalled = false;
      try {
        uploadImage = async () => { uploadCalled = true; return "https://cdn.fal.ai/quoted.png"; };
        submitJob = async (endpoint, input) => {
          captured = { endpoint, input };
          return { statusUrl: "s", responseUrl: "r" };
        };
        pollJob = async () => {};
        getResult = async () => ({ video: { url: "https://example.com/v.mp4", content_type: "video/mp4" } });

        const originalFetch = globalThis.fetch;
        globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (
          async () => ({ ok: true, arrayBuffer: async () => Buffer.from("fake-video").buffer })
        ));
        try {
          await action_fn(
            {
              content: [
                {
                  type: "quote",
                  quotedSenderId: "123",
                  content: [
                    { type: "image", encoding: "base64", mime_type: "image/png", data: "cXVvdGVkLWltZw==" },
                  ],
                },
                { type: "text", text: "animate this" },
              ],
              sendVideo: async () => {},
              log: async () => "",
            },
            { prompt: "animate this" },
          );

          assert.ok(uploadCalled, "uploadImage should have been called for quoted image");
          assert.ok(captured);
          assert.ok(captured.endpoint.endsWith("/image-to-video"));
          assert.equal(captured.input.start_image_url, "https://cdn.fal.ai/quoted.png");
        } finally {
          globalThis.fetch = originalFetch;
        }
      } finally {
        ({ submitJob, pollJob, getResult, uploadImage } = saved);
        if (saved.key !== undefined) process.env.FAL_KEY = saved.key;
        else delete process.env.FAL_KEY;
      }
    },

    async function test_text_only_no_upload(action_fn) {
      const saved = { submitJob, pollJob, getResult, uploadImage, key: process.env.FAL_KEY };
      process.env.FAL_KEY = "test-key";
      let uploadCalled = false;
      /** @type {{ endpoint: string } | undefined} */
      let captured;
      try {
        uploadImage = async () => { uploadCalled = true; return ""; };
        submitJob = async (endpoint) => {
          captured = { endpoint };
          return { statusUrl: "s", responseUrl: "r" };
        };
        pollJob = async () => {};
        getResult = async () => ({ video: { url: "https://example.com/v.mp4", content_type: "video/mp4" } });

        const originalFetch = globalThis.fetch;
        globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (
          async () => ({ ok: true, arrayBuffer: async () => Buffer.from("fake-video").buffer })
        ));
        try {
          await action_fn(
            {
              content: [{ type: "text", text: "a flying car" }],
              sendVideo: async () => {},
              log: async () => "",
            },
            { prompt: "a flying car" },
          );

          assert.ok(!uploadCalled, "uploadImage should NOT have been called");
          assert.ok(captured);
          assert.ok(captured.endpoint.endsWith("/text-to-video"));
        } finally {
          globalThis.fetch = originalFetch;
        }
      } finally {
        ({ submitJob, pollJob, getResult, uploadImage } = saved);
        if (saved.key !== undefined) process.env.FAL_KEY = saved.key;
        else delete process.env.FAL_KEY;
      }
    },

    async function test_returns_error_when_no_fal_key(action_fn) {
      const saved = process.env.FAL_KEY;
      try {
        delete process.env.FAL_KEY;

        const result = await action_fn(
          {
            content: [{ type: "text", text: "test" }],
            sendVideo: async () => {},
            log: async () => "",
          },
          { prompt: "test" },
        );

        assert.ok(typeof result === "string");
        assert.ok(result.includes("FAL_KEY"));
      } finally {
        if (saved !== undefined) process.env.FAL_KEY = saved;
        else delete process.env.FAL_KEY;
      }
    },
  ],
  /**
   * @param {ActionContext} context
   * @param {{ prompt: string, aspect_ratio?: string, duration_seconds?: number, negative_prompt?: string }} params
   */
  action_fn: async function (context, params) {
    const apiKey = config.fal_api_key;
    if (!apiKey) {
      return "Error: FAL_KEY must be configured to generate videos.";
    }

    await context.log(`Generating video: ${params.prompt}`);

    const model = config.video_model;

    // Find image in content (direct or quoted)
    /** @type {ImageContentBlock | undefined} */
    let image;
    for (const block of context.content) {
      if (block.type === "image") { image = block; break; }
      if (block.type === "quote") {
        const inner = block.content.find(
          /** @returns {b is ImageContentBlock} */ (b) => b.type === "image",
        );
        if (inner) { image = inner; break; }
      }
    }

    // Build endpoint and input
    /** @type {Record<string, unknown>} */
    const input = { prompt: params.prompt };
    if (params.duration_seconds) input.duration = String(params.duration_seconds);
    if (params.aspect_ratio) input.aspect_ratio = params.aspect_ratio;
    if (params.negative_prompt) input.negative_prompt = params.negative_prompt;

    /** @type {string} */
    let endpoint;

    try {
      if (image) {
        const fileUrl = await uploadImage(image.data, image.mime_type, apiKey);
        input.start_image_url = fileUrl;
        endpoint = `${model}/image-to-video`;
      } else {
        endpoint = `${model}/text-to-video`;
      }

      const { statusUrl, responseUrl } = await submitJob(endpoint, input, apiKey);
      await pollJob(statusUrl, apiKey);
      const result = await getResult(responseUrl, apiKey);

      if (!result.video?.url) {
        log.warn("fal.ai returned no video. Full response:", JSON.stringify(result, null, 2));
        return "Error: no video was returned by the model. Check logs for details.";
      }

      // Download video from CDN URL
      const downloadRes = await fetch(result.video.url);
      if (!downloadRes.ok) {
        return `Error: Failed to download video (status ${downloadRes.status}).`;
      }

      const arrayBuffer = await downloadRes.arrayBuffer();
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
    } catch (/** @type {unknown} */ err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Video generation failed:", message);
      return `Error: ${message}`;
    }
  },
});
