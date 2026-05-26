import { createAcpHarness, normalizeAcpHarnessConfig } from "./acp.js";
import { registerHarnessDriver } from "./registry.js";

/**
 * Register optional harness implementations that may not be installed in every environment.
 * Missing optional dependencies are ignored quietly; other failures are logged.
 * @returns {Promise<void>}
 */
export async function registerOptionalHarnesses() {
  registerHarnessDriver({
    name: "claude-agent-sdk",
    displayName: "Claude",
    supportsInstances: true,
    docsUrl: "https://github.com/zed-industries/claude-code-acp",
    statusUrl: "https://status.anthropic.com/",
    configSchema: (config) => normalizeAcpHarnessConfig(config, "claude-code-acp"),
    createInstance: ({ config }) => ({ harness: createAcpHarness({ name: "claude-agent-sdk", config, defaultCommand: "claude-code-acp" }) }),
  });
}
