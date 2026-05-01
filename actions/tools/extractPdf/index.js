import { readFile } from "node:fs/promises";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { isValidMediaPath, resolveMediaPath } from "../../../attachment-paths.js";

const MAX_TEXT_CHARS = 30_000;
const DEFAULT_MAX_PAGES = 5;
const MAX_OCR_PAGES = 10;
const OCR_RENDER_SCALE = 1.8;

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} max
 * @returns {number}
 */
function normalizePositiveInteger(value, fallback, max) {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(Math.trunc(parsed), max);
}

/**
 * @param {string} filePath
 * @returns {string}
 */
export function resolvePdfInputPath(filePath) {
  const trimmed = filePath.trim();
  if (isValidMediaPath(trimmed)) {
    return resolveMediaPath(trimmed);
  }
  return path.resolve(trimmed);
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isPasswordError(error) {
  if (!error || typeof error !== "object") {
    return false;
  }
  const record = /** @type {Record<string, unknown>} */ (error);
  const name = typeof record.name === "string" ? record.name.toLowerCase() : "";
  const message = typeof record.message === "string" ? record.message.toLowerCase() : "";
  return name.includes("password") || message.includes("password");
}

/**
 * @param {string} filePath
 * @param {string | undefined} password
 * @returns {Promise<import("pdfjs-dist/types/src/display/api.js").PDFDocumentProxy>}
 */
async function loadPdf(filePath, password) {
  const buffer = await readFile(filePath);
  return getDocument(/** @type {any} */ ({
    data: new Uint8Array(buffer),
    ...(password ? { password } : {}),
    disableWorker: true,
    useSystemFonts: true,
  })).promise;
}

/**
 * @param {import("pdfjs-dist/types/src/display/api.js").PDFDocumentProxy} pdf
 * @param {number} maxPages
 * @returns {Promise<string>}
 */
async function extractEmbeddedText(pdf, maxPages) {
  /** @type {string[]} */
  const pageTexts = [];
  const pageCount = Math.min(pdf.numPages, maxPages);

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ("str" in item && typeof item.str === "string" ? item.str : ""))
      .filter(Boolean)
      .join(" ")
      .replace(/[ \t]+/g, " ")
      .trim();
    if (text) {
      pageTexts.push(`--- Page ${pageNumber} ---\n${text}`);
    }
  }

  return pageTexts.join("\n\n").slice(0, MAX_TEXT_CHARS);
}

/**
 * @param {import("pdfjs-dist/types/src/display/api.js").PDFDocumentProxy} pdf
 * @param {number} pageNumber
 * @returns {Promise<ImageContentBlock>}
 */
async function renderPageImage(pdf, pageNumber) {
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: OCR_RENDER_SCALE });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const canvasContext = canvas.getContext("2d");
  await page.render(/** @type {any} */ ({
    canvas,
    canvasContext,
    viewport,
  })).promise;
  return {
    type: "image",
    mime_type: "image/png",
    encoding: "base64",
    data: canvas.toBuffer("image/png").toString("base64"),
  };
}

/**
 * @param {import("pdfjs-dist/types/src/display/api.js").PDFDocumentProxy} pdf
 * @param {number} maxPages
 * @returns {Promise<ImageContentBlock[]>}
 */
async function renderPdfPages(pdf, maxPages) {
  /** @type {ImageContentBlock[]} */
  const images = [];
  const pageCount = Math.min(pdf.numPages, maxPages, MAX_OCR_PAGES);
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    images.push(await renderPageImage(pdf, pageNumber));
  }
  return images;
}

export default /** @type {defineAction} */ ((x) => x)({
  name: "extract_pdf",
  description:
    "Extract readable text from a PDF file. Supports password-protected PDFs via the optional password parameter and falls back to OCR with a vision model for scanned PDFs.",
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Absolute PDF path or canonical media path from the conversation, for example <sha>.pdf",
      },
      password: {
        type: "string",
        description: "Optional PDF password. If the user sent 'clave ...' or 'password ...' near the PDF, pass that value here.",
      },
      mode: {
        type: "string",
        enum: ["auto", "text", "ocr"],
        description: "auto first tries embedded text and then OCR. text skips OCR. ocr renders pages and uses the vision model.",
      },
      prompt: {
        type: "string",
        description: "Optional OCR prompt. Use this to ask for a summary or specific fields from scanned pages.",
      },
      max_pages: {
        type: "integer",
        description: "Maximum pages to inspect. Defaults to 5; OCR is capped at 10 pages.",
      },
    },
    required: ["file_path"],
  },
  formatToolCall: ({ file_path, mode }) => {
    const name = typeof file_path === "string" ? path.basename(file_path) : "PDF";
    return `Extracting ${mode === "ocr" ? "OCR from" : "text from"} ${name}`;
  },
  instructions: `Use extract_pdf for PDF attachments instead of read_file.
- If a nearby user message says "clave", "password", or "contraseña", pass that value as password.
- Use mode="auto" by default. It reads selectable PDF text first and uses OCR when the PDF appears scanned.
- For scanned letters/forms, include a prompt describing what to extract or summarize.`,
  permissions: {
    useLlm: true,
    autoExecute: true,
    autoContinue: true,
  },
  action_fn: async function (context, params) {
    const rawPath = typeof params.file_path === "string" ? params.file_path.trim() : "";
    if (!rawPath) {
      return "Error: file_path is required.";
    }

    const filePath = resolvePdfInputPath(rawPath);
    const password = typeof params.password === "string" && params.password.length > 0
      ? params.password
      : undefined;
    const mode = params.mode === "text" || params.mode === "ocr" ? params.mode : "auto";
    const maxPages = normalizePositiveInteger(params.max_pages, DEFAULT_MAX_PAGES, MAX_OCR_PAGES);

    /** @type {import("pdfjs-dist/types/src/display/api.js").PDFDocumentProxy} */
    let pdf;
    try {
      pdf = await loadPdf(filePath, password);
    } catch (error) {
      if (isPasswordError(error)) {
        return password
          ? "Error: could not open the PDF with the provided password. Ask the user to confirm the clave/password."
          : "Error: this PDF is password protected. Ask the user for the clave/password, then call extract_pdf again with password.";
      }
      return `Error opening PDF: ${/** @type {Error} */ (error).message}`;
    }

    if (mode !== "ocr") {
      const text = await extractEmbeddedText(pdf, maxPages);
      if (text) {
        const suffix = pdf.numPages > maxPages
          ? `\n\n... (${pdf.numPages - maxPages} more page(s) not read; increase max_pages if needed)`
          : "";
        return `${text}${suffix}`;
      }
      if (mode === "text") {
        return "No selectable text was found in this PDF. It may be scanned; call extract_pdf again with mode=\"ocr\".";
      }
    }

    const images = await renderPdfPages(pdf, maxPages);
    if (images.length === 0) {
      return "No pages could be rendered from this PDF.";
    }

    const prompt = typeof params.prompt === "string" && params.prompt.trim()
      ? params.prompt.trim()
      : "Extract all readable text from these PDF page images. Preserve dates, names, addresses, amounts, and identifiers. If a section is unreadable, say so.";
    const model = context.resolveModel?.("image_to_text");
    const llmResponse = await context.callLlm(
      [...images, { type: "text", text: prompt }],
      model ? { model } : {},
    );
    return llmResponse || "Could not OCR the PDF pages. Try a clearer scan or fewer pages.";
  },
});
