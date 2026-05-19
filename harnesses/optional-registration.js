import { createLogger } from "../logger.js";
import { errorToString } from "../utils.js";
import { registerHarnessDriver } from "./registry.js";

const log = createLogger("harnesses");

/**
 * Register optional harness implementations that may not be installed in every environment.
 * Missing optional dependencies are ignored quietly; other failures are logged.
 * @returns {Promise<void>}
 */
export async function registerOptionalHarnesses() {
  try {
    const { createClaudeAgentSdkHarness } = await import("./claude-agent-sdk.js");
    registerHarnessDriver({
      name: "claude-agent-sdk",
      displayName: "Claude Agent SDK",
      supportsInstances: true,
      docsUrl: "https://docs.anthropic.com/en/docs/claude-code/sdk/sdk-overview",
      statusUrl: "https://status.anthropic.com/",
      createInstance: () => ({ harness: createClaudeAgentSdkHarness() }),
    });
  } catch (error) {
    const message = errorToString(error);
    if (message.includes("Cannot find") || message.includes("MODULE_NOT_FOUND")) {
      log.debug("Claude Agent SDK not installed, skipping harness registration");
      return;
    }
    log.warn("Failed to load Claude Agent SDK harness:", message);
  }
}
