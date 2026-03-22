import {
  CODEX_APPROVAL_POLICIES,
  CODEX_SANDBOX_MODES,
  DEFAULT_CODEX_SANDBOX_MODE,
  getCodexConfig,
  getEffectiveCodexSandboxMode,
  normalizeCodexPermissionsMode,
  updateCodexConfig,
} from "./codex-config.js";
import { contentEvent } from "../outbound-events.js";
import { handleHarnessSessionCommand } from "./session-commands.js";

/**
 * @typedef {{
 *   getAvailableModels: () => Promise<Array<{ id: string, label: string }>>,
 *   cancelActiveQuery: (chatId: string | HarnessSessionRef) => boolean,
 * }} CodexCommandDeps
 */

/**
 * @param {CodexCommandDeps} deps
 * @returns {(input: HarnessCommandContext) => Promise<boolean>}
 */
export function createCodexCommandHandler(deps) {
  return async (input) => handleCodexHarnessCommand(input, deps);
}

/**
 * Handle Codex-specific slash commands.
 * @param {HarnessCommandContext} input
 * @param {CodexCommandDeps} deps
 * @returns {Promise<boolean>}
 */
async function handleCodexHarnessCommand(input, deps) {
  const handledSessionCommand = await handleHarnessSessionCommand({
    command: input.command,
    chatId: input.chatId,
    context: input.context,
    cancelActiveQuery: () => deps.cancelActiveQuery(input.chatId),
    sessionControl: input.sessionControl,
  });
  if (handledSessionCommand) {
    return true;
  }

  const trimmed = input.command.trim();

  const modelMatch = trimmed.match(/^model(?:\s+(.+))?$/i);
  if (modelMatch) {
    const arg = modelMatch[1]?.trim() ?? null;
    if (arg) {
      await input.context.reply(contentEvent("tool-result", await handleModelCommand(input.chatId, arg.toLowerCase(), deps.getAvailableModels)));
      return true;
    }

    const modelOptions = await deps.getAvailableModels();
    const config = await getCodexConfig(input.chatId);
    const currentModel = typeof config.model === "string" && isSelectableCodexModel(config.model, modelOptions)
      ? config.model
      : undefined;
    /** @type {SelectOption[]} */
    const modelSelectOptions = [
      ...modelOptions.map((option) => ({ id: option.id, label: option.label })),
      { id: "off", label: "Default" },
    ];
    const modelChoice = await input.context.select("Choose Codex model", modelSelectOptions, {
      currentId: currentModel,
    });
    if (modelChoice && modelChoice !== currentModel) {
      await handleModelCommand(input.chatId, modelChoice, deps.getAvailableModels);
    }
    const updatedConfig = await getCodexConfig(input.chatId);
    const finalModel = typeof updatedConfig.model === "string" ? updatedConfig.model : "default";
    await input.context.reply(contentEvent("tool-result", `Codex model: \`${finalModel}\``));
    return true;
  }

  const sandboxMatch = trimmed.match(/^sandbox(?:\s+(.+))?$/i);
  if (sandboxMatch) {
    const arg = sandboxMatch[1]?.trim() ?? null;
    if (arg) {
      await input.context.reply(contentEvent("tool-result", await handleSandboxCommand(input.chatId, arg.toLowerCase())));
      return true;
    }
    const config = await getCodexConfig(input.chatId);
    const sandboxMode = getEffectiveCodexSandboxMode(config);
    await input.context.reply(contentEvent("tool-result", `Codex sandbox: \`${sandboxMode}\``));
    return true;
  }

  const permissionsMatch = trimmed.match(/^permissions(?:\s+(.+))?$/i);
  if (permissionsMatch) {
    const arg = permissionsMatch[1]?.trim() ?? null;
    if (arg) {
      await input.context.reply(contentEvent("tool-result", await handlePermissionsCommand(input.chatId, arg.toLowerCase())));
      return true;
    }
    const config = await getCodexConfig(input.chatId);
    const currentPermissions = getEffectiveCodexSandboxMode(config);
    /** @type {SelectOption[]} */
    const permissionOptions = [
      { id: "workspace-write", label: "Workspace Write" },
      { id: "read-only", label: "Read Only" },
      { id: "danger-full-access", label: "Full Access" },
    ];
    const permissionChoice = await input.context.select("Choose Codex permissions", permissionOptions, {
      currentId: currentPermissions,
    });
    if (permissionChoice && permissionChoice !== currentPermissions) {
      await handlePermissionsCommand(input.chatId, permissionChoice);
    }
    const updatedConfig = await getCodexConfig(input.chatId);
    await input.context.reply(contentEvent("tool-result", `Codex permissions: \`${getEffectiveCodexSandboxMode(updatedConfig)}\``));
    return true;
  }

  const approvalMatch = trimmed.match(/^(?:approval|approvals)(?:\s+(.+))?$/i);
  if (approvalMatch) {
    const arg = approvalMatch[1]?.trim() ?? null;
    if (arg) {
      await input.context.reply(contentEvent("tool-result", await handleApprovalCommand(input.chatId, arg.toLowerCase())));
      return true;
    }
    const config = await getCodexConfig(input.chatId);
    const approvalPolicy = typeof config.approvalPolicy === "string" ? config.approvalPolicy : "default";
    await input.context.reply(contentEvent("tool-result", `Codex approval policy: \`${approvalPolicy}\``));
    return true;
  }

  return false;
}

/**
 * @param {string} value
 * @param {Array<{ id: string, label: string }>} modelOptions
 * @returns {boolean}
 */
function isSelectableCodexModel(value, modelOptions) {
  return modelOptions.some((option) => option.id === value);
}

/**
 * @param {Array<{ id: string, label: string }>} modelOptions
 * @returns {string}
 */
function formatModelOptionsHint(modelOptions) {
  return modelOptions.length > 0
    ? modelOptions.map((option) => option.id).join(", ")
    : "no currently available Codex models";
}

/**
 * @param {string} chatId
 * @param {string} arg
 * @param {() => Promise<Array<{ id: string, label: string }>>} getAvailableModels
 * @returns {Promise<string>}
 */
async function handleModelCommand(chatId, arg, getAvailableModels) {
  if (arg === "off" || arg === "default" || arg === "none") {
    await updateCodexConfig(chatId, { model: null });
    return "Codex model reset to default.";
  }
  const modelOptions = await getAvailableModels();
  if (!isSelectableCodexModel(arg, modelOptions)) {
    return `Unknown Codex model \`${arg}\`. Run \`/model\` to choose one of: ${formatModelOptionsHint(modelOptions)}`;
  }
  await updateCodexConfig(chatId, { model: arg });
  return `Codex model set to \`${arg}\``;
}

/**
 * @param {string} chatId
 * @param {string} arg
 * @returns {Promise<string>}
 */
async function handleSandboxCommand(chatId, arg) {
  if (arg === "off" || arg === "default" || arg === "none") {
    await updateCodexConfig(chatId, { sandboxMode: null });
    return `Codex sandbox reset to project default (\`${DEFAULT_CODEX_SANDBOX_MODE}\`).`;
  }
  if (!CODEX_SANDBOX_MODES.has(/** @type {HarnessRunConfig["sandboxMode"]} */ (arg))) {
    return `Unknown sandbox mode \`${arg}\`. Use: ${[...CODEX_SANDBOX_MODES].join(", ")}`;
  }
  await updateCodexConfig(chatId, { sandboxMode: arg });
  return `Codex sandbox set to \`${arg}\``;
}

/**
 * @param {string} chatId
 * @param {string} arg
 * @returns {Promise<string>}
 */
async function handlePermissionsCommand(chatId, arg) {
  if (arg === "off" || arg === "default" || arg === "none") {
    await updateCodexConfig(chatId, { sandboxMode: null });
    return `Codex permissions reset to project default (\`${DEFAULT_CODEX_SANDBOX_MODE}\`).`;
  }
  const sandboxMode = normalizeCodexPermissionsMode(arg);
  if (!sandboxMode) {
    return `Unknown permissions mode \`${arg}\`. Use: workspace-write, read-only, danger-full-access`;
  }
  await updateCodexConfig(chatId, { sandboxMode });
  return `Codex permissions: \`${sandboxMode}\``;
}

/**
 * @param {string} chatId
 * @param {string} arg
 * @returns {Promise<string>}
 */
async function handleApprovalCommand(chatId, arg) {
  if (arg === "off" || arg === "default" || arg === "none") {
    await updateCodexConfig(chatId, { approvalPolicy: null });
    return "Codex approval policy reset to default.";
  }
  if (!CODEX_APPROVAL_POLICIES.has(/** @type {NonNullable<HarnessRunConfig["approvalPolicy"]>} */ (arg))) {
    return `Unknown approval policy \`${arg}\`. Use: ${[...CODEX_APPROVAL_POLICIES].join(", ")}`;
  }
  await updateCodexConfig(chatId, { approvalPolicy: arg });
  return `Codex approval policy set to \`${arg}\``;
}
