/**
 * Public WhatsApp adapter facade.
 *
 * The app-facing boundary is the transport itself. Adapter internals stay
 * private and tests import them directly from their owning modules.
 */
export { createWhatsAppTransport, connectToWhatsApp } from "./create-whatsapp-transport.js";
export { createWhatsAppWorkspacePresenter } from "./workspace-presenter.js";
export {
  formatActivitySummary,
  formatBashCommand,
  formatCommandInspectText,
  formatSdkToolCall,
  formatToolDisplay,
  formatToolInspectBody,
  formatToolPresentationDisplay,
  formatToolPresentationInspect,
  formatToolPresentationSummary,
  getToolCallSummary,
  langFromPath,
  renderToolActivityContent,
  renderToolPresentationContent,
} from "./tool-presenter.js";
