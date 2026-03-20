import { getChatWorkDir } from "../utils.js";

/**
 * Build the harness run config from chat settings.
 * @param {string} chatId
 * @param {import("../store.js").ChatRow | undefined} chatInfo
 * @returns {HarnessRunConfig}
 */
export function buildRunConfig(chatId, chatInfo) {
  return {
    workdir: getChatWorkDir(chatId, chatInfo?.harness_cwd),
    model: chatInfo?.harness_config?.model ?? undefined,
    reasoningEffort: /** @type {HarnessRunConfig["reasoningEffort"]} */ (chatInfo?.harness_config?.reasoningEffort ?? undefined),
    sandboxMode: /** @type {HarnessRunConfig["sandboxMode"]} */ (chatInfo?.harness_config?.sandboxMode ?? undefined),
    approvalPolicy: /** @type {HarnessRunConfig["approvalPolicy"]} */ (chatInfo?.harness_config?.approvalPolicy ?? undefined),
  };
}
