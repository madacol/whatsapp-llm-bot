import { contentEvent } from "../outbound-events.js";
import { storeAndLinkHtml } from "../html-store.js";
import { isHtmlContent } from "../utils.js";

/**
 * @param {{
 *   chatId: string,
 *   context: ExecuteActionContext,
 *   result: ActionResultValue,
 *   afterResponse?: (input?: { handle?: MessageHandle }) => void | Promise<void>,
 * }} input
 * @returns {Promise<void>}
 */
export async function replyCommandResult({ chatId, context, result, afterResponse }) {
  /** @type {MessageHandle | undefined} */
  let responseHandle;
  if (isHtmlContent(result)) {
    const linkText = await storeAndLinkHtml(chatId, result);
    responseHandle = await context.reply(contentEvent("tool-result", linkText));
  } else if (typeof result === "string") {
    responseHandle = await context.reply(contentEvent("tool-result", result));
  } else if (Array.isArray(result)) {
    responseHandle = await context.reply(contentEvent("tool-result", /** @type {ToolContentBlock[]} */ (result)));
  } else {
    responseHandle = await context.reply(contentEvent("tool-result", JSON.stringify(result, null, 2)));
  }
  await afterResponse?.({ handle: responseHandle });
}

/**
 * @param {ExecuteActionContext} context
 * @param {string} message
 * @returns {Promise<void>}
 */
export async function replyCommandError(context, message) {
  await context.reply(contentEvent("error", message));
}
