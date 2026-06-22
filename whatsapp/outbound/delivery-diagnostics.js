import { getDefaultFixtureCapture } from "../../diagnostics/capture.js";

/**
 * @typedef {{
 *   transport: "sendMessage" | "relayMessage" | "messageHandle";
 *   phase: "attempt" | "sent" | "failed" | "queued" | "replaced" | "flushing" | "immediate" | "attached" | "handled" | "ignored";
 *   chatId: string;
 *   message: Record<string, unknown>;
 *   resultKey?: import('@whiskeysockets/baileys').WAMessageKey | null;
 *   options?: Record<string, unknown>;
 *   error?: string;
 *   trace?: Record<string, unknown>;
 * }} WhatsAppOutboundDiagnosticEvent
 */

/**
 * @param {unknown} error
 * @returns {string}
 */
export function formatWhatsAppDeliveryErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {WhatsAppOutboundDiagnosticEvent} event
 * @param {{
 *   fixtureCapture?: import("../../diagnostics/capture.js").FixtureCapture | null,
 * }} [options]
 * @returns {void}
 */
export function appendWhatsAppOutboundDiagnostic(event, options = {}) {
  const fixtureCapture = options.fixtureCapture === undefined ? getDefaultFixtureCapture() : options.fixtureCapture;
  if (!fixtureCapture) {
    return;
  }
  fixtureCapture.capture({
    seam: "whatsapp.outbound",
    direction: "shell_to_baileys",
    event: `${event.transport}.${event.phase}`,
    payload: event,
  });
}
