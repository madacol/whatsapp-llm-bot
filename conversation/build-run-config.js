import { getChatWorkDir } from "../utils.js";
import { getScopedHarnessConfig } from "../harness-config.js";

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
  const workdir = resolvedBinding?.kind === "repo"
    ? resolvedBinding.repo.root_path
    : resolvedBinding?.kind === "workspace"
      ? resolvedBinding.workspace.worktree_path
      : getChatWorkDir(chatId, chatInfo?.harness_cwd, chatName);
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
