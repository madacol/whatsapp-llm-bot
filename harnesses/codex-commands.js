import {
  CODEX_SANDBOX_MODES,
  DEFAULT_CODEX_SANDBOX_MODE,
  getCodexApprovalPolicyOptions,
  getCodexApprovalsReviewerOptions,
  getCodexSandboxModeOptions,
  getCodexConfig,
  getEffectiveCodexSandboxMode,
  isCodexApprovalPolicy,
  normalizeCodexPermissionsMode,
  updateCodexConfig,
} from "./codex-config.js";
import { openCodexAppServerConnection } from "./codex-app-server-client.js";
import { contentEvent } from "../outbound-events.js";
import { handleHarnessSessionCommand } from "./session-commands.js";
import { errorToString } from "../utils.js";

/**
 * @typedef {{
 *   getAvailableModels: () => Promise<Array<{ id: string, label: string }>>,
 *   cancelActiveQuery: (chatId: string | HarnessSessionRef) => boolean,
 *   readThread?: (threadId: string, includeTurns: boolean) => Promise<{ thread?: { id?: string, preview?: string, turns?: Array<{ status?: string, items?: Array<{ type?: string, content?: Array<{ type?: string, text?: string }> }> }> } }>,
 *   forkThread?: (threadId: string) => Promise<{ thread?: { id?: string } }>,
 *   getApprovalPolicyOptions?: () => Promise<NonNullable<HarnessRunConfig["approvalPolicy"]>[]>,
 *   getSandboxModeOptions?: () => Promise<NonNullable<HarnessRunConfig["sandboxMode"]>[]>,
 *   getApprovalsReviewerOptions?: () => Promise<NonNullable<HarnessRunConfig["approvalsReviewer"]>[]>,
 * }} CodexCommandDeps
 */

/**
 * @param {string} threadId
 * @param {boolean} includeTurns
 * @returns {Promise<{ thread?: { id?: string, preview?: string, turns?: Array<{ status?: string, items?: Array<{ type?: string, content?: Array<{ type?: string, text?: string }> }> }> } }>}
 */
async function readCodexThread(threadId, includeTurns) {
  const connection = await openCodexAppServerConnection({ handleRequest: async () => ({}) });
  try {
    return /** @type {Promise<{ thread?: { id?: string, preview?: string, turns?: Array<{ status?: string, items?: Array<{ type?: string, content?: Array<{ type?: string, text?: string }> }> }> } }>} */ (
      connection.sendRequest("thread/read", { threadId, ...(includeTurns ? { includeTurns: true } : {}) })
    );
  } finally {
    await connection.close();
  }
}

/**
 * @param {string} threadId
 * @returns {Promise<{ thread?: { id?: string } }>}
 */
async function forkCodexThread(threadId) {
  const connection = await openCodexAppServerConnection({ handleRequest: async () => ({}) });
  try {
    return /** @type {Promise<{ thread?: { id?: string } }>} */ (
      connection.sendRequest("thread/fork", { threadId, ephemeral: false })
    );
  } finally {
    await connection.close();
  }
}

/**
 * @param {{ preview?: string, turns?: Array<{ status?: string, items?: Array<{ type?: string, content?: Array<{ type?: string, text?: string }> }> }> }} thread
 * @returns {boolean}
 */
function hasCompletedTurns(thread) {
  return Array.isArray(thread.turns) && thread.turns.some((turn) => turn?.status === "completed");
}

/**
 * @param {Array<{ type?: string, content?: Array<{ type?: string, text?: string }> }> | undefined} items
 * @returns {string | null}
 */
function getLastUserMessageText(items) {
  if (!Array.isArray(items)) {
    return null;
  }
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.type !== "userMessage" || !Array.isArray(item.content)) {
      continue;
    }
    const text = item.content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => /** @type {string} */ (part.text).trim())
      .filter(Boolean)
      .join(" ");
    if (text) {
      return text;
    }
  }
  return null;
}

/**
 * @param {string} value
 * @returns {string}
 */
function compactLabel(value) {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length <= 60) {
    return normalized;
  }
  return normalized.slice(0, 60).trimEnd() + "...";
}

/**
 * @param {{ preview?: string, turns?: Array<{ status?: string, items?: Array<{ type?: string, content?: Array<{ type?: string, text?: string }> }> }> }} thread
 * @returns {string | null}
 */
function deriveForkLabel(thread) {
  if (Array.isArray(thread.turns)) {
    for (let i = thread.turns.length - 1; i >= 0; i--) {
      const turn = thread.turns[i];
      if (turn?.status !== "completed") {
        continue;
      }
      const text = getLastUserMessageText(turn.items);
      if (text) {
        return compactLabel(text);
      }
    }
  }
  if (typeof thread.preview === "string" && thread.preview.trim()) {
    return compactLabel(thread.preview);
  }
  return null;
}

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
  const loadThread = deps.readThread ?? readCodexThread;
  const createFork = deps.forkThread ?? forkCodexThread;
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

  if (/^fork$/i.test(trimmed)) {
    const currentSessionId = input.chatInfo?.harness_session_kind === "codex"
      ? input.chatInfo.harness_session_id
      : null;
    if (!currentSessionId || !input.sessionForkControl) {
      await input.context.reply(contentEvent("tool-result", "Can't fork yet. Start a Codex session first."));
      return true;
    }

    try {
      const readResult = await loadThread(currentSessionId, true);
      const thread = readResult.thread ?? {};
      if (!hasCompletedTurns(thread)) {
        await input.context.reply(contentEvent("tool-result", "Can't fork yet. Send at least one normal Codex turn first."));
        return true;
      }

      const label = deriveForkLabel(thread);
      const forked = await createFork(currentSessionId);
      const forkId = forked.thread?.id;
      if (typeof forkId !== "string" || !forkId) {
        throw new Error("Codex app server did not return a fork thread id.");
      }

      await input.sessionForkControl.push(input.chatId, {
        id: currentSessionId,
        kind: "codex",
        label,
      });
      await input.sessionForkControl.save(input.chatId, { id: forkId, kind: "codex" });
      await input.context.reply(contentEvent("tool-result", `Forked${label ? `: ${label}` : ""}. You are now in a side thread. Use \`/back\` to return.`));
      return true;
    } catch (error) {
      await input.context.reply(contentEvent("tool-result", `Codex fork failed: ${errorToString(error)}`));
      return true;
    }
  }

  if (/^back$/i.test(trimmed)) {
    if (!input.sessionForkControl) {
      await input.context.reply(contentEvent("tool-result", "No parent fork to return to."));
      return true;
    }
    const parent = await input.sessionForkControl.pop(input.chatId);
    if (!parent) {
      await input.context.reply(contentEvent("tool-result", "No parent fork to return to."));
      return true;
    }
    await input.sessionForkControl.save(input.chatId, { id: parent.id, kind: parent.kind });
    await input.context.reply(contentEvent("tool-result", `Returned to previous thread${parent.label ? `: ${parent.label}` : ""}.`));
    return true;
  }

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
    const availablePermissions = await getAvailablePermissionsOptions(deps);
    if (arg) {
      await input.context.reply(contentEvent("tool-result", await handlePermissionsCommand(input.chatId, arg.toLowerCase(), availablePermissions)));
      return true;
    }
    const config = await getCodexConfig(input.chatId);
    const currentPermissions = getEffectiveCodexSandboxMode(config);
    /** @type {SelectOption[]} */
    const permissionOptions = availablePermissions.map((option) => ({
      id: option.value,
      label: option.kind === "reviewer"
        ? `Reviewer: ${formatCodexOptionLabel(option.value)}`
        : `Sandbox: ${formatCodexOptionLabel(option.value)}`,
    }));
    const permissionChoice = await input.context.select("Choose Codex permissions", permissionOptions, {
      currentId: getCurrentPermissionSelectId(config, currentPermissions, availablePermissions),
    });
    if (permissionChoice && permissionChoice !== currentPermissions) {
      await handlePermissionsCommand(input.chatId, permissionChoice, availablePermissions);
    }
    const updatedConfig = await getCodexConfig(input.chatId);
    await input.context.reply(contentEvent("tool-result", formatCodexPermissionsSummary(updatedConfig)));
    return true;
  }

  const approvalMatch = trimmed.match(/^(?:approval|approvals)(?:\s+(.+))?$/i);
  if (approvalMatch) {
    const approvalPolicyOptions = await getAvailableApprovalPolicyOptions(deps);
    const arg = approvalMatch[1]?.trim() ?? null;
    if (arg) {
      await input.context.reply(contentEvent("tool-result", await handleApprovalCommand(input.chatId, arg.toLowerCase(), approvalPolicyOptions)));
      return true;
    }
    const config = await getCodexConfig(input.chatId);
    const currentPolicy = isCodexApprovalPolicy(config.approvalPolicy) ? config.approvalPolicy : "off";
    /** @type {SelectOption[]} */
    const approvalSelectOptions = [
      ...approvalPolicyOptions.map((option) => ({ id: option, label: option })),
      { id: "off", label: "Default" },
    ];
    const approvalChoice = await input.context.select("Choose Codex approval policy", approvalSelectOptions, {
      currentId: currentPolicy,
    });
    if (approvalChoice && approvalChoice !== currentPolicy) {
      await handleApprovalCommand(input.chatId, approvalChoice, approvalPolicyOptions);
    }
    const updatedConfig = await getCodexConfig(input.chatId);
    const approvalPolicy = isCodexApprovalPolicy(updatedConfig.approvalPolicy) ? updatedConfig.approvalPolicy : "default";
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
 * @param {string} value
 * @returns {string}
 */
function formatCodexOptionLabel(value) {
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * @param {string} value
 * @returns {string}
 */
function normalizeCodexApprovalsReviewerInput(value) {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/**
 * @param {Record<string, unknown>} config
 * @returns {string}
 */
function formatCodexPermissionsSummary(config) {
  const sandboxMode = getEffectiveCodexSandboxMode(config);
  const approvalsReviewer = typeof config.approvalsReviewer === "string"
    ? config.approvalsReviewer
    : "default";
  return `Codex permissions: sandbox \`${sandboxMode}\`, reviewer \`${approvalsReviewer}\``;
}

/**
 * @param {CodexCommandDeps} deps
 * @returns {Promise<Array<{ kind: "sandbox", value: NonNullable<HarnessRunConfig["sandboxMode"]> } | { kind: "reviewer", value: NonNullable<HarnessRunConfig["approvalsReviewer"]> }>>}
 */
async function getAvailablePermissionsOptions(deps) {
  const sandboxOptions = deps.getSandboxModeOptions
    ? await deps.getSandboxModeOptions()
    : await getCodexSandboxModeOptions();
  const reviewerOptions = deps.getApprovalsReviewerOptions
    ? await deps.getApprovalsReviewerOptions()
    : await getCodexApprovalsReviewerOptions();
  return [
    ...sandboxOptions.map((value) => /** @type {{ kind: "sandbox", value: NonNullable<HarnessRunConfig["sandboxMode"]> }} */ ({ kind: "sandbox", value })),
    ...reviewerOptions.map((value) => /** @type {{ kind: "reviewer", value: NonNullable<HarnessRunConfig["approvalsReviewer"]> }} */ ({ kind: "reviewer", value })),
  ];
}

/**
 * @param {Record<string, unknown>} config
 * @param {NonNullable<HarnessRunConfig["sandboxMode"]>} currentSandboxMode
 * @param {Awaited<ReturnType<typeof getAvailablePermissionsOptions>>} availablePermissions
 * @returns {string}
 */
function getCurrentPermissionSelectId(config, currentSandboxMode, availablePermissions) {
  const approvalsReviewer = typeof config.approvalsReviewer === "string"
    ? config.approvalsReviewer
    : null;
  if (approvalsReviewer && availablePermissions.some((option) => option.kind === "reviewer" && option.value === approvalsReviewer)) {
    return approvalsReviewer;
  }
  return currentSandboxMode;
}

/**
 * @param {string} value
 * @param {Awaited<ReturnType<typeof getAvailablePermissionsOptions>>} availablePermissions
 * @returns {{ kind: "sandbox", value: NonNullable<HarnessRunConfig["sandboxMode"]> } | { kind: "reviewer", value: NonNullable<HarnessRunConfig["approvalsReviewer"]> } | null}
 */
function findAvailablePermissionOption(value, availablePermissions) {
  const sandboxMode = normalizeCodexPermissionsMode(value);
  if (sandboxMode && availablePermissions.some((option) => option.kind === "sandbox" && option.value === sandboxMode)) {
    return { kind: "sandbox", value: sandboxMode };
  }
  const approvalsReviewer = normalizeCodexApprovalsReviewerInput(value);
  const reviewerOption = availablePermissions.find((option) => option.kind === "reviewer" && option.value === approvalsReviewer);
  return reviewerOption?.kind === "reviewer" ? { kind: "reviewer", value: reviewerOption.value } : null;
}

/**
 * @param {string} chatId
 * @param {string} arg
 * @param {Awaited<ReturnType<typeof getAvailablePermissionsOptions>>} availablePermissions
 * @returns {Promise<string>}
 */
async function handlePermissionsCommand(chatId, arg, availablePermissions = []) {
  if (arg === "off" || arg === "default" || arg === "none") {
    await updateCodexConfig(chatId, { sandboxMode: null, approvalsReviewer: null });
    return `Codex permissions reset to project default (\`${DEFAULT_CODEX_SANDBOX_MODE}\`).`;
  }
  const option = findAvailablePermissionOption(arg, availablePermissions.length > 0
    ? availablePermissions
    : [...CODEX_SANDBOX_MODES].map((value) => /** @type {{ kind: "sandbox", value: NonNullable<HarnessRunConfig["sandboxMode"]> }} */ ({ kind: "sandbox", value })));
  if (!option) {
    const availableValues = availablePermissions.map((permission) => permission.value).join(", ");
    return `Unknown permissions mode \`${arg}\`. Use: ${availableValues || [...CODEX_SANDBOX_MODES].join(", ")}`;
  }
  if (option.kind === "reviewer") {
    await updateCodexConfig(chatId, { approvalsReviewer: option.value });
    return `Codex permissions reviewer: \`${option.value}\``;
  }
  await updateCodexConfig(chatId, { sandboxMode: option.value });
  return `Codex permissions: \`${option.value}\``;
}

/**
 * @param {CodexCommandDeps} deps
 * @returns {Promise<NonNullable<HarnessRunConfig["approvalPolicy"]>[]>}
 */
async function getAvailableApprovalPolicyOptions(deps) {
  const options = deps.getApprovalPolicyOptions
    ? await deps.getApprovalPolicyOptions()
    : await getCodexApprovalPolicyOptions();
  const filtered = options.filter(isCodexApprovalPolicy);
  return filtered.length > 0 ? [...new Set(filtered)] : ["untrusted", "on-request", "never"];
}

/**
 * @param {string} chatId
 * @param {string} arg
 * @param {NonNullable<HarnessRunConfig["approvalPolicy"]>[]} availablePolicies
 * @returns {Promise<string>}
 */
async function handleApprovalCommand(chatId, arg, availablePolicies) {
  if (arg === "off" || arg === "default" || arg === "none") {
    await updateCodexConfig(chatId, { approvalPolicy: null });
    return "Codex approval policy reset to default.";
  }
  if (!isCodexApprovalPolicy(arg) || !availablePolicies.includes(arg)) {
    return `Unknown approval policy \`${arg}\`. Use: ${availablePolicies.join(", ")}`;
  }
  await updateCodexConfig(chatId, { approvalPolicy: arg });
  return `Codex approval policy set to \`${arg}\``;
}
