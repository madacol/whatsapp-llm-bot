/**
 * Shared signatures for comparing outbound content blocks after rendering.
 */

/**
 * @param {ToolContentBlock} block
 * @returns {ToolContentBlock | { type: "textual", text: string }}
 */
function normalizeDeliveredContentBlock(block) {
  if ((block.type === "text" || block.type === "markdown") && typeof block.text === "string") {
    return { type: "textual", text: block.text };
  }
  return block;
}

/**
 * @param {SendContent} content
 * @returns {string}
 */
export function getDeliveredContentSignature(content) {
  if (Array.isArray(content)) {
    return JSON.stringify(content.map(normalizeDeliveredContentBlock));
  }
  if (typeof content === "object" && content !== null) {
    return JSON.stringify(normalizeDeliveredContentBlock(content));
  }
  return JSON.stringify(content);
}

/**
 * @param {ToolContentBlock[]} first
 * @param {ToolContentBlock[]} second
 * @returns {ToolContentBlock[]}
 */
export function appendUniqueContentBlocks(first, second) {
  const seen = new Set();
  /** @type {ToolContentBlock[]} */
  const merged = [];
  for (const block of [...first, ...second]) {
    const signature = getDeliveredContentSignature(block);
    if (seen.has(signature)) {
      continue;
    }
    seen.add(signature);
    merged.push(block);
  }
  return merged;
}
