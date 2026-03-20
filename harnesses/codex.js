/**
 * Codex harness — uses the local Codex SDK for stateful agent runs.
 */

import { NO_OP_HOOKS } from "./native.js";
import { startCodexRun } from "./codex-runner.js";
import { extractCodexText } from "./codex-event-utils.js";
import { getCodexAvailableModels } from "./codex-models.js";
import { handleHarnessSessionCommand } from "./session-commands.js";
import {
  CODEX_APPROVAL_POLICIES,
  CODEX_SANDBOX_MODES,
  DEFAULT_CODEX_SANDBOX_MODE,
  getCodexConfig,
  getCodexSessionId,
  getEffectiveCodexSandboxMode,
  normalizeCodexPermissionsMode,
  saveCodexSession,
  updateCodexConfig,
} from "./codex-config.js";
export { buildCodexThreadOptions } from "./codex-runner.js";

/** @type {HarnessCapabilities} */
const CODEX_HARNESS_CAPABILITIES = {
  supportsResume: true,
  supportsCancel: true,
  supportsLiveInput: false,
  supportsApprovals: true,
  supportsWorkdir: true,
  supportsSandboxConfig: true,
  supportsModelSelection: true,
  supportsReasoningEffort: false,
  supportsSessionFork: false,
};

/**
 * @typedef {{
 *   abortController: AbortController;
 *   done: Promise<{ result: AgentResult, sessionId: string | null }>;
 *   aborted: boolean;
 * }} ActiveCodexRun
 */

/**
 * @typedef {{
 *   getAvailableModels?: () => Promise<Array<{ id: string, label: string }>>,
 * }} CodexHarnessDeps
 */

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

/**
 * Handle Codex-specific slash commands.
 * @param {HarnessCommandContext} input
 * @param {(chatId: string | HarnessSessionRef) => boolean} cancelActiveQuery
 * @param {() => Promise<Array<{ id: string, label: string }>>} getAvailableModels
 * @returns {Promise<boolean>}
 */
async function handleCodexHarnessCommand(input, cancelActiveQuery, getAvailableModels) {
  const handledSessionCommand = await handleHarnessSessionCommand({
    command: input.command,
    chatId: input.chatId,
    context: input.context,
    cancelActiveQuery: () => cancelActiveQuery(input.chatId),
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
      await input.context.reply("tool-result", await handleModelCommand(input.chatId, arg.toLowerCase(), getAvailableModels));
      return true;
    }

    const modelOptions = await getAvailableModels();
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
      await handleModelCommand(input.chatId, modelChoice, getAvailableModels);
    }
    const updatedConfig = await getCodexConfig(input.chatId);
    const finalModel = typeof updatedConfig.model === "string" ? updatedConfig.model : "default";
    await input.context.reply("tool-result", `Codex model: \`${finalModel}\``);
    return true;
  }

  const sandboxMatch = trimmed.match(/^sandbox(?:\s+(.+))?$/i);
  if (sandboxMatch) {
    const arg = sandboxMatch[1]?.trim() ?? null;
    if (arg) {
      await input.context.reply("tool-result", await handleSandboxCommand(input.chatId, arg.toLowerCase()));
      return true;
    }
    const config = await getCodexConfig(input.chatId);
    const sandboxMode = getEffectiveCodexSandboxMode(config);
    await input.context.reply("tool-result", `Codex sandbox: \`${sandboxMode}\``);
    return true;
  }

  const permissionsMatch = trimmed.match(/^permissions(?:\s+(.+))?$/i);
  if (permissionsMatch) {
    const arg = permissionsMatch[1]?.trim() ?? null;
    if (arg) {
      await input.context.reply("tool-result", await handlePermissionsCommand(input.chatId, arg.toLowerCase()));
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
    await input.context.reply("tool-result", `Codex permissions: \`${getEffectiveCodexSandboxMode(updatedConfig)}\``);
    return true;
  }

  const approvalMatch = trimmed.match(/^(?:approval|approvals)(?:\s+(.+))?$/i);
  if (approvalMatch) {
    const arg = approvalMatch[1]?.trim() ?? null;
    if (arg) {
      await input.context.reply("tool-result", await handleApprovalCommand(input.chatId, arg.toLowerCase()));
      return true;
    }
    const config = await getCodexConfig(input.chatId);
    const approvalPolicy = typeof config.approvalPolicy === "string" ? config.approvalPolicy : "default";
    await input.context.reply("tool-result", `Codex approval policy: \`${approvalPolicy}\``);
    return true;
  }

  return false;
}

/**
 * Create the Codex harness.
 * @param {CodexHarnessDeps} [deps]
 * @returns {AgentHarness}
 */
export function createCodexHarness(deps = {}) {
  /** @type {Map<string, ActiveCodexRun>} */
  const activeRuns = new Map();
  const loadAvailableModels = deps.getAvailableModels ?? getCodexAvailableModels;

  return {
    getName: () => "codex",
    getCapabilities: () => CODEX_HARNESS_CAPABILITIES,
    run,
    handleCommand: (input) => handleCodexHarnessCommand(input, cancel, loadAvailableModels),
    cancel,
    waitForIdle,
  };

  /**
   * @param {string | HarnessSessionRef} chatId
   * @returns {boolean}
   */
  function cancel(chatId) {
    const key = typeof chatId === "string" ? chatId : chatId.id;
    const active = activeRuns.get(key);
    if (!active) {
      return false;
    }
    active.aborted = true;
    active.abortController.abort();
    return true;
  }

  /**
   * @returns {Promise<string[]>}
   */
  async function waitForIdle() {
    const chatIds = [...activeRuns.keys()];
    await Promise.allSettled(chatIds.map((chatId) => activeRuns.get(chatId)?.done));
    return chatIds;
  }

  /**
   * @param {AgentHarnessParams} params
   * @returns {Promise<AgentResult>}
   */
  async function run({ session, messages, hooks: userHooks, runConfig }) {
    const hooks = { ...NO_OP_HOOKS, ...userHooks };
    const prompt = extractCodexText(messages.at(-1)?.content) ?? "";
    if (!prompt) {
      return {
        response: [{ type: "text", text: "No input message found." }],
        messages,
        usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
      };
    }

    const sessionId = getCodexSessionId(session);
    /** @type {ActiveCodexRun | null} */
    let activeRun = null;
    const started = await startCodexRun({
      chatId: session.chatId,
      prompt,
      messages,
      sessionId,
      runConfig,
      hooks,
      isAborted: () => activeRun?.aborted ?? false,
    });
    activeRun = {
      abortController: started.abortController,
      done: started.done,
      aborted: false,
    };
    activeRuns.set(session.chatId, activeRun);

    try {
      const completed = await started.done;

      if (completed.sessionId && completed.sessionId !== sessionId) {
        await saveCodexSession(session, completed.sessionId);
      }

      return completed.result;
    } finally {
      activeRuns.delete(session.chatId);
    }
  }
}
