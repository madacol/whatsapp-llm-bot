import { getChatWorkDir } from "../utils.js";

/**
 * Build the harness run config from chat settings.
 * @param {string} chatId
 * @param {import("../store.js").ChatRow | undefined} chatInfo
 * @param {string | null | undefined} [chatName]
 * @returns {HarnessRunConfig}
 */
export function buildRunConfig(chatId, chatInfo, chatName) {
  return {
    workdir: getChatWorkDir(chatId, chatInfo?.harness_cwd, chatName),
    model: chatInfo?.harness_config?.model ?? undefined,
    reasoningEffort: /** @type {HarnessRunConfig["reasoningEffort"]} */ (chatInfo?.harness_config?.reasoningEffort ?? undefined),
    // Project workspaces are writable by default so coding harnesses can edit files
    // without requiring per-chat sandbox setup.
    sandboxMode: /** @type {HarnessRunConfig["sandboxMode"]} */ (chatInfo?.harness_config?.sandboxMode ?? "workspace-write"),
    approvalPolicy: /** @type {HarnessRunConfig["approvalPolicy"]} */ (chatInfo?.harness_config?.approvalPolicy ?? undefined),
  };
}
