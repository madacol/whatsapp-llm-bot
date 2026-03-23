import { createLogger } from "../logger.js";
import { errorToString } from "../utils.js";
import { registerHarness } from "./registry.js";

const log = createLogger("harnesses");

/**
 * Register optional harness implementations that may not be installed in every environment.
 * Missing optional dependencies are ignored quietly; other failures are logged.
 * @returns {Promise<void>}
 */
export async function registerOptionalHarnesses() {
  try {
    const { createClaudeAgentSdkHarness } = await import("./claude-agent-sdk.js");
    registerHarness("claude-agent-sdk", createClaudeAgentSdkHarness);
  } catch (error) {
    const message = errorToString(error);
    if (message.includes("Cannot find") || message.includes("MODULE_NOT_FOUND")) {
      log.debug("Claude Agent SDK not installed, skipping harness registration");
      return;
    }
    log.warn("Failed to load Claude Agent SDK harness:", message);
  }
}
