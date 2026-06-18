import { createAppOutputPort } from "../app-output-port.js";
import { storeAndLinkHtml } from "../html-store.js";
import { isHtmlContent } from "../utils.js";

/**
 * @param {{
 *   chatId: string,
 *   context: ExecuteActionContext,
 *   result: ToolResultValue,
 *   afterResponse?: (input?: { handle?: MessageHandle }) => void | Promise<void>,
 * }} input
 * @returns {Promise<void>}
 */
export async function replyCommandResult({ chatId, context, result, afterResponse }) {
  const appOutput = createAppOutputPort(context);
  /** @type {MessageHandle | undefined} */
  let responseHandle;
  if (isHtmlContent(result)) {
    const linkText = await storeAndLinkHtml(chatId, result);
    responseHandle = await appOutput.replyWithToolResult(linkText);
  } else if (typeof result === "string") {
    responseHandle = await appOutput.replyWithToolResult(result);
  } else if (Array.isArray(result)) {
    responseHandle = await appOutput.replyWithToolResult(/** @type {ToolContentBlock[]} */ (result));
  } else {
    responseHandle = await appOutput.replyWithToolResult(JSON.stringify(result, null, 2));
  }
  await afterResponse?.({ handle: responseHandle });
}

/**
 * @param {ExecuteActionContext} context
 * @param {string} message
 * @returns {Promise<void>}
 */
export async function replyCommandError(context, message) {
  await createAppOutputPort(context).replyWithError(message);
}
