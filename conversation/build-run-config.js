import { getChatWorkDir } from "../utils.js";
import { getHarnessInstanceConfig } from "../harness-config.js";
import { resolveOutputVisibility } from "../chat-output-visibility.js";

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
 * @param {unknown} value
 * @returns {string[] | undefined}
 */
function normalizeStringList(value) {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .filter((entry) => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
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
  const { instanceId, config: harnessConfig } = getHarnessInstanceConfig(
    chatInfo?.harness_config,
    harnessName ?? chatInfo?.harness,
  );
  const configValues = harnessConfig.configValues && typeof harnessConfig.configValues === "object" && !Array.isArray(harnessConfig.configValues)
    ? /** @type {Record<string, string | boolean | null>} */ (harnessConfig.configValues)
    : undefined;
  const workdir = resolveRunWorkdir(chatId, chatInfo, chatName, resolvedBinding);
  const protectedPaths = normalizeStringList(harnessConfig.protectedPaths);
  const ignoredFileChangePaths = normalizeStringList(harnessConfig.ignoredFileChangePaths);
  const outputVisibility = resolveOutputVisibility(chatInfo?.output_visibility);
  return {
    workdir,
    harnessInstanceId: instanceId,
    model: typeof harnessConfig.model === "string" ? harnessConfig.model : undefined,
    mode: typeof harnessConfig.mode === "string" ? harnessConfig.mode : undefined,
    reasoningEffort: /** @type {HarnessRunConfig["reasoningEffort"]} */ (typeof harnessConfig.reasoningEffort === "string" ? harnessConfig.reasoningEffort : undefined),
    // Project workspaces are writable by default so coding harnesses can edit files
    // without requiring per-chat sandbox setup.
    sandboxMode: /** @type {HarnessRunConfig["sandboxMode"]} */ (typeof harnessConfig.sandboxMode === "string" ? harnessConfig.sandboxMode : "workspace-write"),
    approvalPolicy: /** @type {HarnessRunConfig["approvalPolicy"]} */ (typeof harnessConfig.approvalPolicy === "string" ? harnessConfig.approvalPolicy : undefined),
    approvalsReviewer: /** @type {HarnessRunConfig["approvalsReviewer"]} */ (typeof harnessConfig.approvalsReviewer === "string" ? harnessConfig.approvalsReviewer : undefined),
    snapshotFileChanges: outputVisibility.snapshots === "on",
    ...(protectedPaths ? { protectedPaths } : {}),
    ...(ignoredFileChangePaths ? { ignoredFileChangePaths } : {}),
    ...(configValues ? { configValues } : {}),
  };
}
