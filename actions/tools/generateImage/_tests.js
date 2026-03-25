import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** @type {ActionTestFn[]} */
export default [
async function test_generates_image_from_prompt(action_fn) {
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (async () => ({
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                role: "assistant",
                content: "A beautiful sunset",
                images: [{
                  type: "image_url",
                  image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
                }],
              },
            }],
          }),
        })));

        const result = await action_fn(
          {
            content: [],
            send: async () => {},
            log: async () => "",
          },
          { prompt: "a sunset" },
        );

        const signal = /** @type {ActionResult} */ (/** @type {unknown} */ (result));
        assert.ok(Array.isArray(signal.result));
        const blocks = /** @type {ToolContentBlock[]} */ (signal.result);
        assert.ok(blocks.some((b) => b.type === "text"));
        assert.ok(blocks.some((b) => b.type === "image"));
      } finally {
        globalThis.fetch = originalFetch;
      }
    },

    async function test_passes_input_images_for_editing(action_fn) {
      const originalFetch = globalThis.fetch;
      /** @type {unknown} */
      let capturedBody;
      try {
        globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (async (/** @type {string} */ _url, /** @type {RequestInit} */ init) => {
          capturedBody = JSON.parse(/** @type {string} */ (init.body));
          return {
            ok: true,
            json: async () => ({
              choices: [{
                message: {
                  role: "assistant",
                  content: "Edited image",
                  images: [{
                    type: "image_url",
                    image_url: { url: "data:image/png;base64,AAAA" },
                  }],
                },
              }],
            }),
          };
        }));

        await action_fn(
          {
            content: [],
            send: async () => {},
            log: async () => "",
          },
          {
            images: [{ type: "image", encoding: "base64", mime_type: "image/jpeg", data: "abc123" }],
            prompt: "make it blue",
          },
        );

        // Check that the input image was included in the request
        const body = /** @type {{messages: Array<{content: Array<{type: string, image_url?: {url: string}}>}>}} */ (capturedBody);
        const userContent = body.messages[0].content;
        const imagepart = userContent.find((/** @type {{type: string}} */ p) => p.type === "image_url");
        assert.ok(imagepart, "Request should include input image");
      } finally {
        globalThis.fetch = originalFetch;
      }
    },

    async function test_accepts_temp_file_paths_for_editing(action_fn) {
      const originalFetch = globalThis.fetch;
      const tempDir = await mkdtemp(path.join(tmpdir(), "generate-image-"));
      const imagePath = path.join(tempDir, "input.jpg");
      const images = /** @type {Array<string | ImageContentBlock>} */ ([imagePath]);
      /** @type {unknown} */
      let capturedBody;
      await writeFile(imagePath, Buffer.from("aGVsbG8=", "base64"));

      try {
        globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (async (/** @type {string} */ _url, /** @type {RequestInit} */ init) => {
          capturedBody = JSON.parse(/** @type {string} */ (init.body));
          return {
            ok: true,
            json: async () => ({
              choices: [{
                message: {
                  role: "assistant",
                  content: "Edited image",
                  images: [{
                    type: "image_url",
                    image_url: { url: "data:image/png;base64,AAAA" },
                  }],
                },
              }],
            }),
          };
        }));

        await action_fn(
          {
            content: [],
            send: async () => {},
            log: async () => "",
          },
          {
            images,
            prompt: "make it blue",
          },
        );
      } finally {
        globalThis.fetch = originalFetch;
        await rm(tempDir, { recursive: true, force: true });
      }

      const body = /** @type {{messages: Array<{content: Array<{type: string, image_url?: {url: string}}>}>}} */ (capturedBody);
      const userContent = body.messages[0].content;
      const imagepart = userContent.find((/** @type {{type: string}} */ p) => p.type === "image_url");
      assert.ok(imagepart, "Request should include the temp-file image");
    },

    async function test_deduplicates_images_from_content_array_and_images_field(action_fn) {
      const originalFetch = globalThis.fetch;
      const imageDataUrl = "data:image/png;base64,iVBORw0KGgo=";
      try {
        // Simulate API returning the same image in both content array and images field
        globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (async () => ({
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                role: "assistant",
                content: [
                  { type: "text", text: "Here is the image" },
                  { type: "image_url", image_url: { url: imageDataUrl } },
                ],
                images: [
                  { type: "image_url", image_url: { url: imageDataUrl } },
                ],
              },
            }],
          }),
        })));

        const result = await action_fn(
          {
            content: [],
            send: async () => {},
            log: async () => "",
          },
          { prompt: "a cat" },
        );

        const blocks = /** @type {ToolContentBlock[]} */ (/** @type {ActionResult} */ (/** @type {unknown} */ (result)).result);
        const imageBlocks = blocks.filter((b) => b.type === "image");
        assert.equal(imageBlocks.length, 1, "Should have exactly 1 image content block");
        assert.ok(blocks.some((b) => b.type === "text" && /** @type {TextContentBlock} */ (b).text === "Here is the image"));
      } finally {
        globalThis.fetch = originalFetch;
      }
    },

    async function test_handles_api_error(action_fn) {
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (async () => ({
          ok: false,
          status: 500,
          text: async () => "Internal Server Error",
        })));

        const result = await action_fn(
          {
            content: [],
            send: async () => {},
            log: async () => "",
          },
          { prompt: "test" },
        );

        assert.ok(typeof result === "string");
        assert.ok(result.includes("500"));
      } finally {
        globalThis.fetch = originalFetch;
      }
    },

    async function test_handles_response_with_no_images(action_fn) {
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (async () => ({
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                role: "assistant",
                content: "I cannot generate that image",
              },
            }],
          }),
        })));

        const result = await action_fn(
          {
            content: [],
            send: async () => {},
            log: async () => "",
          },
          { prompt: "test" },
        );

        assert.ok(typeof result === "string");
        assert.ok(result.includes("I cannot generate that image"));
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
];
