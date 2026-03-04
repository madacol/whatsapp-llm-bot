import assert from "node:assert/strict";
import { falApi } from "./index.js";

export default [
    async function test_generates_video_from_prompt(action_fn) {
      const saved = { ...falApi, key: process.env.FAL_KEY };
      process.env.FAL_KEY = "test-key";
      /** @type {Array<{video: Buffer, caption?: string}>} */
      const sentVideos = [];
      try {
        falApi.submitJob = async () => ({ statusUrl: "s", responseUrl: "r" });
        falApi.pollJob = async () => {};
        falApi.getResult = async () => ({ video: { url: "https://example.com/v.mp4", content_type: "video/mp4" } });

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
        Object.assign(falApi, saved);
        if (saved.key !== undefined) process.env.FAL_KEY = saved.key;
        else delete process.env.FAL_KEY;
      }
    },

    async function test_passes_all_parameters(action_fn) {
      const saved = { ...falApi, key: process.env.FAL_KEY };
      process.env.FAL_KEY = "test-key";
      /** @type {{ endpoint: string, input: Record<string, unknown> } | undefined} */
      let captured;
      try {
        falApi.submitJob = async (endpoint, input) => {
          captured = { endpoint, input };
          return { statusUrl: "s", responseUrl: "r" };
        };
        falApi.pollJob = async () => {};
        falApi.getResult = async () => ({ video: { url: "https://example.com/v.mp4", content_type: "video/mp4" } });

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
        Object.assign(falApi, saved);
        if (saved.key !== undefined) process.env.FAL_KEY = saved.key;
        else delete process.env.FAL_KEY;
      }
    },

    async function test_handles_api_error(action_fn) {
      const saved = { ...falApi, key: process.env.FAL_KEY };
      process.env.FAL_KEY = "test-key";
      try {
        falApi.submitJob = async () => { throw new Error("fal.ai submit failed (403): Forbidden"); };

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
        Object.assign(falApi, saved);
        if (saved.key !== undefined) process.env.FAL_KEY = saved.key;
        else delete process.env.FAL_KEY;
      }
    },

    async function test_handles_no_video(action_fn) {
      const saved = { ...falApi, key: process.env.FAL_KEY };
      process.env.FAL_KEY = "test-key";
      try {
        falApi.submitJob = async () => ({ statusUrl: "s", responseUrl: "r" });
        falApi.pollJob = async () => {};
        falApi.getResult = async () => /** @type {FalResult} */ (/** @type {unknown} */ ({}));

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
        Object.assign(falApi, saved);
        if (saved.key !== undefined) process.env.FAL_KEY = saved.key;
        else delete process.env.FAL_KEY;
      }
    },

    async function test_sends_image_as_reference(action_fn) {
      const saved = { ...falApi, key: process.env.FAL_KEY };
      process.env.FAL_KEY = "test-key";
      /** @type {{ endpoint: string, input: Record<string, unknown> } | undefined} */
      let captured;
      let uploadCalled = false;
      try {
        falApi.uploadImage = async () => { uploadCalled = true; return "https://cdn.fal.ai/uploaded.jpg"; };
        falApi.submitJob = async (endpoint, input) => {
          captured = { endpoint, input };
          return { statusUrl: "s", responseUrl: "r" };
        };
        falApi.pollJob = async () => {};
        falApi.getResult = async () => ({ video: { url: "https://example.com/v.mp4", content_type: "video/mp4" } });

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
        Object.assign(falApi, saved);
        if (saved.key !== undefined) process.env.FAL_KEY = saved.key;
        else delete process.env.FAL_KEY;
      }
    },

    async function test_sends_quoted_image(action_fn) {
      const saved = { ...falApi, key: process.env.FAL_KEY };
      process.env.FAL_KEY = "test-key";
      /** @type {{ endpoint: string, input: Record<string, unknown> } | undefined} */
      let captured;
      let uploadCalled = false;
      try {
        falApi.uploadImage = async () => { uploadCalled = true; return "https://cdn.fal.ai/quoted.png"; };
        falApi.submitJob = async (endpoint, input) => {
          captured = { endpoint, input };
          return { statusUrl: "s", responseUrl: "r" };
        };
        falApi.pollJob = async () => {};
        falApi.getResult = async () => ({ video: { url: "https://example.com/v.mp4", content_type: "video/mp4" } });

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
        Object.assign(falApi, saved);
        if (saved.key !== undefined) process.env.FAL_KEY = saved.key;
        else delete process.env.FAL_KEY;
      }
    },

    async function test_text_only_no_upload(action_fn) {
      const saved = { ...falApi, key: process.env.FAL_KEY };
      process.env.FAL_KEY = "test-key";
      let uploadCalled = false;
      /** @type {{ endpoint: string } | undefined} */
      let captured;
      try {
        falApi.uploadImage = async () => { uploadCalled = true; return ""; };
        falApi.submitJob = async (endpoint) => {
          captured = { endpoint };
          return { statusUrl: "s", responseUrl: "r" };
        };
        falApi.pollJob = async () => {};
        falApi.getResult = async () => ({ video: { url: "https://example.com/v.mp4", content_type: "video/mp4" } });

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
        Object.assign(falApi, saved);
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
];
