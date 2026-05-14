/**
 * Detect slash commands that mean subsequent model/media prompts should not
 * include earlier chat history as context.
 * @param {string} text
 * @returns {boolean}
 */
export function isContextResetCommandText(text) {
  return /^\/(?:clear|clean)(?:\s|$)/i.test(text.trim());
}

/**
 * @param {Array<{ type: string, text?: string }>} content
 * @returns {boolean}
 */
export function contentHasContextResetCommand(content) {
  return content.some((block) => block.type === "text" && typeof block.text === "string" && isContextResetCommandText(block.text));
}
