import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolvePdfInputPath } from "./index.js";
import { resolveMediaPath } from "../../../attachment-paths.js";

/**
 * @param {string} text
 * @returns {Buffer}
 */
function buildSimplePdf(text) {
  const escapedText = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${`BT /F1 18 Tf 72 720 Td (${escapedText}) Tj ET`.length} >>\nstream\nBT /F1 18 Tf 72 720 Td (${escapedText}) Tj ET\nendstream`,
  ];

  let pdf = "%PDF-1.4\n";
  /** @type {number[]} */
  const offsets = [0];
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "utf8");
}

/** @type {ActionTestFn[]} */
export default [
  async function resolves_canonical_media_paths() {
    const mediaPath = `${"a".repeat(64)}.pdf`;
    assert.equal(resolvePdfInputPath(mediaPath), resolveMediaPath(mediaPath));
  },

  async function extracts_embedded_pdf_text(action_fn) {
    const dir = await mkdtemp(path.join(tmpdir(), "extract-pdf-test-"));
    const pdfPath = path.join(dir, "letter.pdf");
    await writeFile(pdfPath, buildSimplePdf("Hello from selectable PDF text"));
    try {
      const result = await action_fn(/** @type {Partial<FullActionContext>} */ ({
        resolveModel: () => "",
        callLlm: async () => {
          throw new Error("OCR should not be called for selectable text");
        },
      }), { file_path: pdfPath, mode: "auto" });
      assert.match(result, /Hello from selectable PDF text/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },

  async function can_force_ocr_mode(action_fn) {
    const dir = await mkdtemp(path.join(tmpdir(), "extract-pdf-ocr-test-"));
    const pdfPath = path.join(dir, "letter.pdf");
    await writeFile(pdfPath, buildSimplePdf("Rendered PDF text"));
    try {
      const result = await action_fn(/** @type {Partial<FullActionContext>} */ ({
        resolveModel: () => "vision-model",
        callLlm: /** @type {CallLlm} */ (async (prompt, options) => {
          assert.equal(options?.model, "vision-model");
          assert.ok(Array.isArray(prompt));
          assert.equal(prompt[0]?.type, "image");
          assert.equal(prompt.at(-1)?.type, "text");
          return "OCR result";
        }),
      }), { file_path: pdfPath, mode: "ocr", prompt: "read it" });
      assert.equal(result, "OCR result");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
];
