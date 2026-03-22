import {
  hydrateHdRef,
  rekeyHdDeferred,
  resolveHdDeferred,
  updateStoredHdRef,
} from "../../whatsapp-hd-media.js";

/**
 * @typedef {{ url?: string; directPath?: string; mediaKey: string; mimetype?: string }} HdChildRef
 */

/**
 * @typedef {{
 *   parentMessageId?: string,
 *   child?: {
 *     parentMessageId?: string,
 *     ref: HdChildRef,
 *     imageBlock: ImageContentBlock | null,
 *   },
 * }} HdInboundLifecycle
 */

/**
 * @returns {HdInboundLifecycle | undefined}
 */
export function createEmptyHdInboundLifecycle() {
  return undefined;
}

/**
 * @param {IncomingContentBlock[]} content
 * @returns {void}
 */
export function hydrateHdContentBlocks(content) {
  for (const block of content) {
    if (block.type === "image") {
      hydrateHdRef(block);
    }
  }
}

/**
 * @param {{
 *   content: IncomingContentBlock[],
 *   hdChild?: {
 *     parentMessageId?: string,
 *     ref: HdChildRef,
 *     imageBlock: ImageContentBlock | null,
 *   },
 *   hdParentMessageId?: string,
 * }} imageResult
 * @returns {{ content: IncomingContentBlock[], lifecycle: HdInboundLifecycle | undefined }}
 */
export function finalizeHdImageResult(imageResult) {
  if (imageResult.content.length > 0) {
    hydrateHdContentBlocks(imageResult.content);
  }

  const lifecycle = imageResult.hdChild || imageResult.hdParentMessageId
    ? {
      ...(imageResult.hdParentMessageId ? { parentMessageId: imageResult.hdParentMessageId } : {}),
      ...(imageResult.hdChild ? { child: imageResult.hdChild } : {}),
    }
    : undefined;

  return {
    content: imageResult.content,
    lifecycle,
  };
}

/**
 * @param {{
 *   rawChatId: string,
 *   chatId: string,
 *   lifecycle: HdInboundLifecycle | undefined,
 * }} input
 * @returns {Promise<void>}
 */
export async function applyHdInboundLifecycle(input) {
  const { rawChatId, chatId, lifecycle } = input;
  if (!lifecycle) {
    return;
  }

  if (lifecycle.parentMessageId) {
    rekeyHdDeferred(rawChatId, chatId, lifecycle.parentMessageId);
  }

  if (lifecycle.child) {
    resolveHdDeferred(chatId, lifecycle.child.parentMessageId, lifecycle.child.imageBlock);
    await updateStoredHdRef(chatId, lifecycle.child.parentMessageId, lifecycle.child.ref);
  }
}
