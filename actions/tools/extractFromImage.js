import assert from "node:assert/strict";
import { resolveModel } from "../../model-roles.js";

const EXTRACT_PROMPT = `Extrae datos de la factura en JSON estricto (solo JSON):
{
  "store_name": "nombre",
  "purchase_date": "YYYY-MM-DD o null",
  "items": [{ "item_name": "nombre", "quantity": 1, "unit_price": 0.0, "subtotal": 0.0 }],
  "total": 0.0
}

Reglas:
- Solo números en precios (sin símbolos).
- Usa null si el dato es ilegible.
- Extrae TODOS los productos individuales.
- Excluye descuentos, cupones o subtotales de la lista de items.
- "total" es el monto final neto pagado.
- Sin texto adicional ni markdown.`;

/**
 * @param {string} raw - Raw LLM response (may contain markdown fences)
 * @returns {{ store_name: string|null, purchase_date: string|null, items: Array<{item_name: string, quantity: number, unit_price: number, subtotal: number}>, total: number }}
 */
function parseExtractResponse(raw) {
  const cleaned = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
  return JSON.parse(cleaned);
}

export { EXTRACT_PROMPT, parseExtractResponse };

export default /** @type {defineAction} */ ((x) => x)({
  name: "extract_from_image",
  command: "extract",
  description:
    "Extract structured data from an image using a vision model. Send an image along with a prompt describing what to extract. Returns the raw LLM response text.",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "What to extract from the image (e.g. invoice data, text content, etc.)",
      },
    },
    required: ["prompt"],
  },
  permissions: {
    useLlm: true,
    autoExecute: true,
    autoContinue: true,
  },
  test_functions: [
    async function returns_error_when_no_image(action_fn) {
      const result = await action_fn(
        {
          callLlm: async () => null,
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

      /** @type {ContentBlock[]} */
      const contentWithImage = [
        { type: "image", encoding: "base64", mime_type: "image/jpeg", data: "fakebase64" },
      ];

      await action_fn(
        {
          callLlm: async (/** @type {ContentBlock[]} */ prompt, /** @type {CallLlmOptions} */ opts) => {
            capturedPrompt = prompt;
            capturedOptions = opts;
            return "extracted text";
          },
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
      /** @type {ContentBlock[]} */
      const contentWithImage = [
        { type: "image", encoding: "base64", mime_type: "image/jpeg", data: "fakebase64" },
      ];

      const result = await action_fn(
        {
          callLlm: async () => '{"store_name": "Test", "items": [], "total": 42}',
          content: contentWithImage,
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

      /** @type {ContentBlock[]} */
      const contentWithImages = [
        { type: "image", encoding: "base64", mime_type: "image/jpeg", data: "img1" },
        { type: "text", text: "some text" },
        { type: "image", encoding: "base64", mime_type: "image/png", data: "img2" },
      ];

      await action_fn(
        {
          callLlm: async (/** @type {ContentBlock[]} */ prompt) => {
            capturedPrompt = prompt;
            return "result";
          },
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
  ],
  prompt: () => EXTRACT_PROMPT,
  test_prompts: [
    async function extract_prompt_returns_valid_json(callLlm, _readFixture, prompt) {
      /** @type {ContentBlock[]} */
      const content = [
        {
          type: "text",
          text: `Here is the text content of a receipt:

SUPERMERCADO EL SOL
Fecha: 15/06/2025
---
Leche entera 1L    x2    €1.50    €3.00
Pan integral       x1    €1.20    €1.20
Agua mineral 1.5L  x3    €0.60    €1.80
---
TOTAL: €6.00

` + prompt(),
        },
      ];
      const response = await callLlm(content);
      assert.ok(response, "LLM should return a response");

      const data = parseExtractResponse(/** @type {string} */ (response));
      assert.ok(data.store_name, "should extract store name");
      assert.ok(Array.isArray(data.items), "items should be an array");
      assert.ok(data.items.length >= 3, `should extract at least 3 items, got ${data.items.length}`);
      assert.equal(typeof data.total, "number", "total should be a number");
      assert.ok(data.total > 0, "total should be > 0");

      for (const item of data.items) {
        assert.ok(item.item_name, "each item should have a name");
        assert.equal(typeof item.quantity, "number", "quantity should be a number");
      }
    },
    async function extract_from_receipt_image(callLlm, readFixture, prompt) {
      const imageBuffer = await readFixture("receipt-1.jpeg");
      const base64 = imageBuffer.toString("base64");

      /** @type {ContentBlock[]} */
      const content = [
        { type: "image", encoding: "base64", mime_type: "image/jpeg", data: base64 },
        { type: "text", text: prompt() },
      ];

      const response = await callLlm(content, { model: resolveModel("image_to_text") });
      assert.ok(response, "LLM should return a response");

      const data = parseExtractResponse(/** @type {string} */ (response));

      assert.ok(data.store_name, "should extract store name");
      assert.match(
        data.store_name.toLowerCase(),
        /dunnes/,
        `store name should contain 'dunnes', got '${data.store_name}'`,
      );

      assert.equal(data.purchase_date, "2026-02-17", `date should be 2026-02-17, got '${data.purchase_date}'`);

      assert.ok(Array.isArray(data.items), "items should be an array");
      assert.ok(data.items.length >= 13, `should extract at least 13 items, got ${data.items.length}`);
      assert.ok(data.items.length <= 17, `should extract at most 17 items, got ${data.items.length}`);

      for (const item of data.items) {
        assert.ok(item.item_name, "each item should have a name");
        assert.equal(typeof item.quantity, "number", `quantity should be a number for '${item.item_name}'`);
        assert.equal(typeof item.subtotal, "number", `subtotal should be a number for '${item.item_name}'`);
        assert.ok(item.subtotal > 0, `subtotal should be > 0 for '${item.item_name}'`);
      }

      const allNames = data.items.map(i => i.item_name.toLowerCase()).join(" | ");
      for (const keyword of ["mince", "salmon", "milk", "vinegar", "rice"]) {
        assert.ok(allNames.includes(keyword), `should find '${keyword}' in items, got: ${allNames}`);
      }

      const itemsSum = data.items.reduce((sum, item) => sum + item.subtotal, 0);
      assert.ok(
        Math.abs(itemsSum - 51.53) < 2.0,
        `items should sum to ~51.53, got ${itemsSum.toFixed(2)}`,
      );

      assert.equal(data.total, 31.22, `total should be 31.22, got ${data.total}`);
    },
  ],
  action_fn: async function (context, params) {
    const { callLlm, content, log, resolveModel: ctxResolveModel } = context;

    /** @type {ImageContentBlock[]} */
    const images = /** @type {ImageContentBlock[]} */ (content.filter(c => c.type === "image"));
    if (images.length === 0) {
      return "No image found. Please send an image along with your message.";
    }

    await log("Extracting from image...");

    /** @type {ContentBlock[]} */
    const prompt = [
      ...images,
      { type: "text", text: params.prompt },
    ];

    const model = ctxResolveModel?.("image_to_text");
    const llmResponse = await callLlm(prompt, model ? { model } : {});
    if (!llmResponse) {
      return "Could not extract data from the image. Try with a clearer photo.";
    }

    return llmResponse;
  },
});
