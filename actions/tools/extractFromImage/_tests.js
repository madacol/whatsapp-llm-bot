import assert from "node:assert/strict";

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
        { prompt: "extract data" },
      );
      assert.ok(typeof result === "string");
      assert.ok(result.includes("No image found"));
    },

    async function calls_llm_with_image_and_prompt(action_fn) {
      /** @type {ContentBlock[] | undefined} */
      let capturedPrompt;
      /** @type {CallLlmOptions | undefined} */
      let capturedOptions;

      /** @type {IncomingContentBlock[]} */
      const contentWithImage = [
        { type: "image", encoding: "base64", mime_type: "image/jpeg", data: "fakebase64" },
      ];

      await action_fn(
        {
          callLlm: /** @type {CallLlm} */ (/** @type {Function} */ (async (/** @type {ContentBlock[]} */ prompt, /** @type {CallLlmOptions} */ opts) => {
            capturedPrompt = prompt;
            capturedOptions = opts;
            return "extracted text";
          })),
          content: contentWithImage,
          log: async () => "",
          resolveModel: () => "vision-model",
        },
        { prompt: "extract invoice data" },
      );

      assert.ok(Array.isArray(capturedPrompt), "prompt should be an array");
      assert.equal(capturedPrompt[0].type, "image", "first element should be the image");
      const textBlock = capturedPrompt[capturedPrompt.length - 1];
      assert.equal(textBlock.type, "text");
      assert.ok(/** @type {TextContentBlock} */ (textBlock).text.includes("extract invoice data"));
      assert.deepEqual(capturedOptions, { model: "vision-model" });
    },

    async function returns_raw_llm_response(action_fn) {
      /** @type {IncomingContentBlock[]} */
      const contentWithImage2 = [
        { type: "image", encoding: "base64", mime_type: "image/jpeg", data: "fakebase64" },
      ];

      const result = await action_fn(
        {
          callLlm: /** @type {CallLlm} */ (/** @type {Function} */ (async () => '{"store_name": "Test", "items": [], "total": 42}')),
          content: contentWithImage2,
          log: async () => "",
          resolveModel: () => "test-model",
        },
        { prompt: "extract data" },
      );
      assert.equal(result, '{"store_name": "Test", "items": [], "total": 42}');
    },

    async function extracts_multiple_images(action_fn) {
      /** @type {ContentBlock[] | undefined} */
      let capturedPrompt;

      /** @type {IncomingContentBlock[]} */
      const contentWithImages = [
        { type: "image", encoding: "base64", mime_type: "image/jpeg", data: "img1" },
        { type: "text", text: "some text" },
        { type: "image", encoding: "base64", mime_type: "image/png", data: "img2" },
      ];

      await action_fn(
        {
          callLlm: /** @type {CallLlm} */ (/** @type {Function} */ (async (/** @type {ContentBlock[]} */ prompt) => {
            capturedPrompt = prompt;
            return "result";
          })),
          content: contentWithImages,
          log: async () => "",
          resolveModel: () => "vision-model",
        },
        { prompt: "extract all" },
      );

      assert.ok(Array.isArray(capturedPrompt));
      const images = capturedPrompt.filter((/** @type {ContentBlock} */ b) => b.type === "image");
      assert.equal(images.length, 2, "should include both images");
    },
];
