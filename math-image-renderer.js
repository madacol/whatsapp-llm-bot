import { Resvg } from "@resvg/resvg-js";
import { mathjax } from "mathjax-full/js/mathjax.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { AllPackages } from "mathjax-full/js/input/tex/AllPackages.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";

const MATH_PADDING = 48;
const MATH_BACKGROUND = "#ffffff";
const MATH_FOREGROUND = "#111827";

/**
 * @typedef {{
 *   convert: (tex: string, options: { display: boolean }) => import("mathjax-full/js/adaptors/lite/Element.js").LiteElement,
 * }} MathSvgDocument
 */

/** @type {ReturnType<typeof liteAdaptor> | null} */
let adaptor = null;
/** @type {MathSvgDocument | null} */
let mathDocument = null;

/**
 * @returns {{ adaptor: ReturnType<typeof liteAdaptor>, document: MathSvgDocument }}
 */
function getMathDocument() {
  if (!adaptor || !mathDocument) {
    adaptor = liteAdaptor();
    RegisterHTMLHandler(adaptor);
    const inputJax = new TeX({ packages: AllPackages });
    const outputJax = new SVG({ fontCache: "none" });
    mathDocument = mathjax.document("", {
      InputJax: inputJax,
      OutputJax: outputJax,
    });
  }

  return {
    adaptor,
    document: mathDocument,
  };
}

/**
 * @param {string} svgMarkup
 * @returns {{ minX: number, minY: number, width: number, height: number, innerMarkup: string }}
 */
function extractSvgGeometry(svgMarkup) {
  const viewBoxMatch = svgMarkup.match(/viewBox="([^"]+)"/);
  if (!viewBoxMatch) {
    throw new Error("MathJax SVG is missing a viewBox");
  }

  const viewBoxParts = viewBoxMatch[1].trim().split(/\s+/).map(Number);
  if (viewBoxParts.length !== 4 || viewBoxParts.some((value) => !Number.isFinite(value))) {
    throw new Error("MathJax SVG has an invalid viewBox");
  }

  const innerMarkupMatch = svgMarkup.match(/<svg[^>]*>([\s\S]*)<\/svg>/);
  if (!innerMarkupMatch) {
    throw new Error("MathJax SVG did not contain inner markup");
  }

  return {
    minX: viewBoxParts[0],
    minY: viewBoxParts[1],
    width: viewBoxParts[2],
    height: viewBoxParts[3],
    innerMarkup: innerMarkupMatch[1],
  };
}

/**
 * @param {string} tex
 * @returns {Promise<Buffer>}
 */
export async function renderDisplayMathToImage(tex) {
  const { adaptor: activeAdaptor, document } = getMathDocument();
  const mathNode = document.convert(tex, { display: true });
  const svgMarkup = activeAdaptor.innerHTML(mathNode);
  const geometry = extractSvgGeometry(svgMarkup);
  const outputWidth = Math.ceil(geometry.width + MATH_PADDING * 2);
  const outputHeight = Math.ceil(geometry.height + MATH_PADDING * 2);
  const translateX = MATH_PADDING - geometry.minX;
  const translateY = MATH_PADDING - geometry.minY;

  const wrappedSvg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${outputWidth}" height="${outputHeight}" viewBox="0 0 ${outputWidth} ${outputHeight}" role="img">`,
    `<rect width="100%" height="100%" rx="18" fill="${MATH_BACKGROUND}"/>`,
    `<g transform="translate(${translateX} ${translateY})" color="${MATH_FOREGROUND}" fill="${MATH_FOREGROUND}" stroke="${MATH_FOREGROUND}">`,
    geometry.innerMarkup,
    "</g>",
    "</svg>",
  ].join("");

  const rendered = new Resvg(wrappedSvg).render();
  return Buffer.from(rendered.asPng());
}
