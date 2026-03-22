/**
 * Public WhatsApp adapter facade.
 *
 * Transport-facing semantics live here. Presentation helpers are intentionally
 * kept outside the WhatsApp namespace so non-transport callers do not depend on
 * WhatsApp internals for generic rendering policy.
 */

import { createConfirmRuntime } from "./runtime/confirm-runtime.js";
import { createReactionRuntime } from "./runtime/reaction-runtime.js";
import { createSelectRuntime } from "./runtime/select-runtime.js";

export { createWhatsAppTransport, connectToWhatsApp } from "./create-whatsapp-transport.js";
export { getMessageContent } from "./inbound/message-content.js";
export { adaptIncomingMessage } from "./inbound/chat-turn.js";
export { editWhatsAppMessage, sendAlbum, sendBlocks } from "./outbound/send-content.js";
export { getPollCreationData, createSelectRuntime } from "./runtime/select-runtime.js";
export { createConfirmRuntime } from "./runtime/confirm-runtime.js";
export { createReactionRuntime } from "./runtime/reaction-runtime.js";

/**
 * Compatibility alias for the previous select registry name.
 * @returns {import("./runtime/select-runtime.js").SelectRuntime}
 */
export function createUserResponseRegistry() {
  return createSelectRuntime();
}

/**
 * Compatibility alias for the previous confirm registry name.
 * @returns {import("./runtime/confirm-runtime.js").ConfirmRuntime}
 */
export function createConfirmRegistry() {
  return createConfirmRuntime();
}

/**
 * Compatibility alias for the previous reaction registry name.
 * @returns {import("./runtime/reaction-runtime.js").ReactionRuntime}
 */
export function createReactionRegistry() {
  return createReactionRuntime();
}
