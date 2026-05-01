import { getChatWorkDir } from "../utils.js";
import { getScopedHarnessConfig } from "../harness-config.js";

/**
 * @param {string} chatId
 * @param {import("../store.js").ChatRow | undefined} chatInfo
 * @param {string | null | undefined} chatName
 * @param {ResolvedChatBinding | undefined} resolvedBinding
 * @returns {string}
 */
function resolveRunWorkdir(chatId, chatInfo, chatName, resolvedBinding) {
  if (chatInfo?.harness_cwd) {
    return getChatWorkDir(chatId, chatInfo.harness_cwd, chatName);
  }
  if (resolvedBinding?.kind === "project") {
    return resolvedBinding.project.root_path;
  }
  if (resolvedBinding?.kind === "workspace") {
    return resolvedBinding.workspace.worktree_path;
  }
  return getChatWorkDir(chatId, chatInfo?.harness_cwd, chatName);
}

/**
 * Build the harness run config from chat settings.
 * @param {string} chatId
 * @param {import("../store.js").ChatRow | undefined} chatInfo
 * @param {string | null | undefined} [chatName]
 * @param {string | null | undefined} [harnessName]
 * @param {ResolvedChatBinding | undefined} [resolvedBinding]
 * @returns {HarnessRunConfig}
 */
export function buildRunConfig(chatId, chatInfo, chatName, harnessName, resolvedBinding) {
  const harnessConfig = getScopedHarnessConfig(chatInfo?.harness_config, harnessName ?? chatInfo?.harness);
  const workdir = resolveRunWorkdir(chatId, chatInfo, chatName, resolvedBinding);
  return {
    workdir,
    model: typeof harnessConfig.model === "string" ? harnessConfig.model : undefined,
    reasoningEffort: /** @type {HarnessRunConfig["reasoningEffort"]} */ (typeof harnessConfig.reasoningEffort === "string" ? harnessConfig.reasoningEffort : undefined),
    // Project workspaces are writable by default so coding harnesses can edit files
    // without requiring per-chat sandbox setup.
    sandboxMode: /** @type {HarnessRunConfig["sandboxMode"]} */ (typeof harnessConfig.sandboxMode === "string" ? harnessConfig.sandboxMode : "workspace-write"),
    approvalPolicy: /** @type {HarnessRunConfig["approvalPolicy"]} */ (typeof harnessConfig.approvalPolicy === "string" ? harnessConfig.approvalPolicy : undefined),
  };
}
