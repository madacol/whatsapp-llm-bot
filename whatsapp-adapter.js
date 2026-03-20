/**
 * Public WhatsApp adapter facade.
 * Keeps the old export surface for compatibility while delegating the
 * implementation to smaller transport-focused modules.
 */

import { createConfirmRuntime } from "./whatsapp/runtime/confirm-runtime.js";
import { createReactionRuntime } from "./whatsapp/runtime/reaction-runtime.js";
import { createSelectRuntime } from "./whatsapp/runtime/select-runtime.js";

export { createWhatsAppTransport, connectToWhatsApp } from "./whatsapp/create-whatsapp-transport.js";
export { getMessageContent } from "./whatsapp/inbound/message-content.js";
export { adaptIncomingMessage } from "./whatsapp/inbound/chat-turn.js";
export { editWhatsAppMessage, sendAlbum, sendBlocks } from "./whatsapp/outbound/send-content.js";
export { getPollCreationData, createSelectRuntime } from "./whatsapp/runtime/select-runtime.js";
export { createConfirmRuntime } from "./whatsapp/runtime/confirm-runtime.js";
export { createReactionRuntime } from "./whatsapp/runtime/reaction-runtime.js";

/**
 * Compatibility alias for the previous select registry name.
 * @returns {import("./whatsapp/runtime/select-runtime.js").SelectRuntime}
 */
export function createUserResponseRegistry() {
  return createSelectRuntime();
}

/**
 * Compatibility alias for the previous confirm registry name.
 * @returns {import("./whatsapp/runtime/confirm-runtime.js").ConfirmRuntime}
 */
export function createConfirmRegistry() {
  return createConfirmRuntime();
}

/**
 * Compatibility alias for the previous reaction registry name.
 * @returns {import("./whatsapp/runtime/reaction-runtime.js").ReactionRuntime}
 */
export function createReactionRegistry() {
  return createReactionRuntime();
}
