
import { normalizeImageInputs } from "../../../media-temp-files.js";

const EXTRACT_PROMPT = `Extrae datos de la factura en JSON estricto (solo JSON):
{
  "store_name": "nombre",
  "purchase_date": "YYYY-MM-DD o null",
  "items": [{ "item_name": "nombre", "quantity": 1, "unit_price": 0.0, "subtotal": 0.0 }],
  "discounts": [{ "description": "nombre/tipo del descuento", "amount": 0.0 }],
  "subtotal": 0.0,
  "total": 0.0
}

Reglas:
- Solo números en precios (sin símbolos).
- Usa null si el dato es ilegible.
- Extrae TODOS los productos individuales.
- Excluye descuentos, cupones o subtotales de la lista de items.
- "discounts" son todos los descuentos aplicados (empleado, cupones, vales, etc). Si no hay, usa [].
- "subtotal" es la suma antes de descuentos (BAL).
- "total" es el monto final neto pagado (después de descuentos).
- Sin texto adicional ni markdown.`;

/**
 * @param {string} raw - Raw LLM response (may contain markdown fences)
 * @returns {{ store_name: string|null, purchase_date: string|null, items: Array<{item_name: string, quantity: number, unit_price: number, subtotal: number}>, discounts: Array<{description: string, amount: number}>, subtotal: number, total: number }}
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
      images: {
        type: "array",
        items: { type: "image" },
        description: "Images to extract data from",
      },
      prompt: {
        type: "string",
        description: "What to extract from the image (e.g. invoice data, text content, etc.)",
      },
    },
    required: ["images", "prompt"],
  },
  formatToolCall: ({ prompt }) => {
    const maxLen = 60;
    const label = "Extracting";
    if (!prompt) return label;
    const short = prompt.length > maxLen ? prompt.slice(0, maxLen) + "…" : prompt;
    return `${label}: "${short}"`;
  },
  permissions: {
    useLlm: true,
    autoExecute: true,
    autoContinue: true,
  },
  prompt: () => EXTRACT_PROMPT,
  /**
   * @param {ExtendedActionContext<{ useLlm: true, autoExecute: true, autoContinue: true }>} context
   * @param {{ images?: Array<string | ImageContentBlock>, prompt: string }} params
   */
  action_fn: async function (context, params) {
    const { callLlm, resolveModel: ctxResolveModel } = context;

    const images = await normalizeImageInputs(params.images ?? []);
    if (images.length === 0) {
      return "No image found. Please send an image along with your message.";
    }

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
