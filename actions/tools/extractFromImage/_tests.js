import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** @type {ActionTestFn[]} */
export default [
async function returns_error_when_no_image(action_fn) {
      const result = await action_fn(
        {
          callLlm: /** @type {CallLlm} */ (/** @type {Function} */ (async () => null)),
          content: [],
          log: async () => "",
          resolveModel: () => "test-model",
        },
        { images: [], prompt: "extract data" },
      );
      assert.ok(typeof result === "string");
      assert.ok(result.includes("No image found"));
    },

    async function calls_llm_with_image_and_prompt(action_fn) {
      /** @type {ContentBlock[] | undefined} */
      let capturedPrompt;
      /** @type {CallLlmOptions | undefined} */
      let capturedOptions;

      /** @type {ImageContentBlock[]} */
      const images = [
        { type: "image", encoding: "base64", mime_type: "image/jpeg", data: "fakebase64" },
      ];

      await action_fn(
        {
          callLlm: /** @type {CallLlm} */ (/** @type {Function} */ (async (/** @type {ContentBlock[]} */ prompt, /** @type {CallLlmOptions} */ opts) => {
            capturedPrompt = prompt;
            capturedOptions = opts;
            return "extracted text";
          })),
          content: [],
          log: async () => "",
          resolveModel: () => "vision-model",
        },
        { images, prompt: "extract invoice data" },
      );

      assert.ok(Array.isArray(capturedPrompt), "prompt should be an array");
      assert.equal(capturedPrompt[0].type, "image", "first element should be the image");
      const textBlock = capturedPrompt[capturedPrompt.length - 1];
      assert.equal(textBlock.type, "text");
      assert.ok(/** @type {TextContentBlock} */ (textBlock).text.includes("extract invoice data"));
      assert.deepEqual(capturedOptions, { model: "vision-model" });
    },

    async function returns_raw_llm_response(action_fn) {
      /** @type {ImageContentBlock[]} */
      const images = [
        { type: "image", encoding: "base64", mime_type: "image/jpeg", data: "fakebase64" },
      ];

      const result = await action_fn(
        {
          callLlm: /** @type {CallLlm} */ (/** @type {Function} */ (async () => '{"store_name": "Test", "items": [], "total": 42}')),
          content: [],
          log: async () => "",
          resolveModel: () => "test-model",
        },
        { images, prompt: "extract data" },
      );
      assert.equal(result, '{"store_name": "Test", "items": [], "total": 42}');
    },

    async function extracts_multiple_images(action_fn) {
      /** @type {ContentBlock[] | undefined} */
      let capturedPrompt;

      /** @type {ImageContentBlock[]} */
      const images = [
        { type: "image", encoding: "base64", mime_type: "image/jpeg", data: "img1" },
        { type: "image", encoding: "base64", mime_type: "image/png", data: "img2" },
      ];

      await action_fn(
        {
          callLlm: /** @type {CallLlm} */ (/** @type {Function} */ (async (/** @type {ContentBlock[]} */ prompt) => {
            capturedPrompt = prompt;
            return "result";
          })),
          content: [],
          log: async () => "",
          resolveModel: () => "vision-model",
        },
        { images, prompt: "extract all" },
      );

      assert.ok(Array.isArray(capturedPrompt));
      const imageBlocks = capturedPrompt.filter((/** @type {ContentBlock} */ b) => b.type === "image");
      assert.equal(imageBlocks.length, 2, "should include both images");
    },

    async function accepts_temp_file_paths(action_fn) {
      const tempDir = await mkdtemp(path.join(tmpdir(), "extract-from-image-"));
      const imagePath = path.join(tempDir, "input.png");
      await writeFile(imagePath, Buffer.from("aGVsbG8=", "base64"));
      const images = /** @type {Array<string | ImageContentBlock>} */ ([imagePath]);

      /** @type {ContentBlock[] | undefined} */
      let capturedPrompt;
      try {
        await action_fn(
          {
            callLlm: /** @type {CallLlm} */ (/** @type {Function} */ (async (/** @type {ContentBlock[]} */ prompt) => {
              capturedPrompt = prompt;
              return "result";
            })),
            content: [],
            log: async () => "",
            resolveModel: () => "vision-model",
          },
          { images, prompt: "extract all" },
        );
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }

      assert.ok(Array.isArray(capturedPrompt));
      const imageBlock = capturedPrompt.find((/** @type {ContentBlock} */ block) => block.type === "image");
      assert.ok(imageBlock, "should convert the temp file into an image block");
      assert.equal(/** @type {ImageContentBlock} */ (imageBlock).data, "aGVsbG8=");
    },
];
