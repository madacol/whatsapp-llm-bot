import { registerAcpAgentDriver } from "./registry.js";

/**
 * Register optional harness implementations that may not be installed in every environment.
 * Missing optional dependencies are ignored quietly; other failures are logged.
 * @returns {Promise<void>}
 */
export async function registerOptionalHarnesses() {
  registerAcpAgentDriver({
    name: "claude",
    displayName: "Claude",
    command: "claude-agent-acp",
    docsUrl: "https://github.com/agentclientprotocol/claude-agent-acp",
    statusUrl: "https://status.anthropic.com/",
    sessionKind: "claude",
  });
}
