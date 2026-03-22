/**
 * Public WhatsApp adapter facade.
 *
 * The app-facing boundary is the transport itself. Adapter internals stay
 * private and tests import them directly from their owning modules.
 */
export { createWhatsAppTransport, connectToWhatsApp } from "./create-whatsapp-transport.js";
