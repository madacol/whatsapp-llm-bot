/**
 * Codex harness — uses the local Codex SDK for stateful agent runs.
 */

import { NO_OP_HOOKS } from "./native.js";
import { startCodexRun } from "./codex-runner.js";
import { extractCodexText } from "./codex-event-utils.js";
import { getCodexAvailableModels } from "./codex-models.js";
import { getRootDb } from "../db.js";
import { handleHarnessSessionCommand } from "./session-commands.js";
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

/** @type {Set<HarnessRunConfig["sandboxMode"]>} */
const SANDBOX_MODES = new Set(["read-only", "workspace-write", "danger-full-access"]);

/** @type {Set<NonNullable<HarnessRunConfig["approvalPolicy"]>>} */
const APPROVAL_POLICIES = new Set(["untrusted", "on-request", "never"]);

/** @type {NonNullable<HarnessRunConfig["sandboxMode"]>} */
const DEFAULT_CODEX_SANDBOX_MODE = "workspace-write";

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
 * Read the generic harness_config JSONB for a chat.
 * @param {string} chatId
 * @returns {Promise<Record<string, unknown>>}
 */
async function getHarnessConfig(chatId) {
  const db = getRootDb();
  const { rows: [row] } = await db.sql`SELECT harness_config FROM chats WHERE chat_id = ${chatId}`;
  const config = row?.harness_config;
  return config && typeof config === "object" && !Array.isArray(config)
    ? config
    : {};
}

/**
 * Update the generic harness_config JSONB for a chat.
 * Null/undefined values remove keys from the stored config.
 * @param {string} chatId
 * @param {Record<string, unknown>} patch
 * @returns {Promise<void>}
 */
async function updateHarnessConfig(chatId, patch) {
  const db = getRootDb();
  const current = await getHarnessConfig(chatId);
  for (const [key, value] of Object.entries(patch)) {
    if (value == null) {
      delete current[key];
    } else {
      current[key] = value;
    }
  }
  await db.sql`UPDATE chats SET harness_config = ${JSON.stringify(current)} WHERE chat_id = ${chatId}`;
}

/**
 * Persist the current Codex session through the generic API when available.
 * @param {Session} session
 * @param {string | null} sessionId
 * @returns {Promise<void>}
 */
async function saveCodexSessionId(session, sessionId) {
  if (session.saveHarnessSession) {
    await session.saveHarnessSession(
      session.chatId,
      sessionId ? { id: sessionId, kind: "codex" } : null,
    );
  }
}

/**
 * @param {Session} session
 * @returns {string | null}
 */
function getCodexSessionId(session) {
  if (session.harnessSession?.kind === "codex") {
    return session.harnessSession.id;
  }
  return null;
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
 * @param {Record<string, unknown>} config
 * @returns {NonNullable<HarnessRunConfig["sandboxMode"]>}
 */
function getEffectiveSandboxMode(config) {
  if (typeof config.sandboxMode === "string" && SANDBOX_MODES.has(/** @type {HarnessRunConfig["sandboxMode"]} */ (config.sandboxMode))) {
    return /** @type {NonNullable<HarnessRunConfig["sandboxMode"]>} */ (config.sandboxMode);
  }
  return DEFAULT_CODEX_SANDBOX_MODE;
}

/**
 * @param {string} value
 * @returns {NonNullable<HarnessRunConfig["sandboxMode"]> | null}
 */
function normalizePermissionsMode(value) {
  if (value === "write" || value === "workspace" || value === "workspace-write") {
    return "workspace-write";
  }
  if (value === "readonly" || value === "read-only" || value === "read") {
    return "read-only";
  }
  if (value === "full" || value === "full-access" || value === "danger-full-access") {
    return "danger-full-access";
  }
  return null;
}

/**
 * @param {string} chatId
 * @param {string} arg
 * @param {() => Promise<Array<{ id: string, label: string }>>} getAvailableModels
 * @returns {Promise<string>}
 */
async function handleModelCommand(chatId, arg, getAvailableModels) {
  if (arg === "off" || arg === "default" || arg === "none") {
    await updateHarnessConfig(chatId, { model: null });
    return "Codex model reset to default.";
  }
  const modelOptions = await getAvailableModels();
  if (!isSelectableCodexModel(arg, modelOptions)) {
    return `Unknown Codex model \`${arg}\`. Run \`/model\` to choose one of: ${formatModelOptionsHint(modelOptions)}`;
  }
  await updateHarnessConfig(chatId, { model: arg });
  return `Codex model set to \`${arg}\``;
}

/**
 * @param {string} chatId
 * @param {string} arg
 * @returns {Promise<string>}
 */
async function handleSandboxCommand(chatId, arg) {
  if (arg === "off" || arg === "default" || arg === "none") {
    await updateHarnessConfig(chatId, { sandboxMode: null });
    return `Codex sandbox reset to project default (\`${DEFAULT_CODEX_SANDBOX_MODE}\`).`;
  }
  if (!SANDBOX_MODES.has(/** @type {HarnessRunConfig["sandboxMode"]} */ (arg))) {
    return `Unknown sandbox mode \`${arg}\`. Use: ${[...SANDBOX_MODES].join(", ")}`;
  }
  await updateHarnessConfig(chatId, { sandboxMode: arg });
  return `Codex sandbox set to \`${arg}\``;
}

/**
 * @param {string} chatId
 * @param {string} arg
 * @returns {Promise<string>}
 */
async function handlePermissionsCommand(chatId, arg) {
  if (arg === "off" || arg === "default" || arg === "none") {
    await updateHarnessConfig(chatId, { sandboxMode: null });
    return `Codex permissions reset to project default (\`${DEFAULT_CODEX_SANDBOX_MODE}\`).`;
  }
  const sandboxMode = normalizePermissionsMode(arg);
  if (!sandboxMode) {
    return `Unknown permissions mode \`${arg}\`. Use: workspace-write, read-only, danger-full-access`;
  }
  await updateHarnessConfig(chatId, { sandboxMode });
  return `Codex permissions: \`${sandboxMode}\``;
}

/**
 * @param {string} chatId
 * @param {string} arg
 * @returns {Promise<string>}
 */
async function handleApprovalCommand(chatId, arg) {
  if (arg === "off" || arg === "default" || arg === "none") {
    await updateHarnessConfig(chatId, { approvalPolicy: null });
    return "Codex approval policy reset to default.";
  }
  if (!APPROVAL_POLICIES.has(/** @type {NonNullable<HarnessRunConfig["approvalPolicy"]>} */ (arg))) {
    return `Unknown approval policy \`${arg}\`. Use: ${[...APPROVAL_POLICIES].join(", ")}`;
  }
  await updateHarnessConfig(chatId, { approvalPolicy: arg });
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
    const config = await getHarnessConfig(input.chatId);
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
    const updatedConfig = await getHarnessConfig(input.chatId);
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
    const config = await getHarnessConfig(input.chatId);
    const sandboxMode = getEffectiveSandboxMode(config);
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
    const config = await getHarnessConfig(input.chatId);
    const currentPermissions = getEffectiveSandboxMode(config);
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
    const updatedConfig = await getHarnessConfig(input.chatId);
    await input.context.reply("tool-result", `Codex permissions: \`${getEffectiveSandboxMode(updatedConfig)}\``);
    return true;
  }

  const approvalMatch = trimmed.match(/^(?:approval|approvals)(?:\s+(.+))?$/i);
  if (approvalMatch) {
    const arg = approvalMatch[1]?.trim() ?? null;
    if (arg) {
      await input.context.reply("tool-result", await handleApprovalCommand(input.chatId, arg.toLowerCase()));
      return true;
    }
    const config = await getHarnessConfig(input.chatId);
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
        await saveCodexSessionId(session, completed.sessionId);
      }

      return completed.result;
    } finally {
      activeRuns.delete(session.chatId);
    }
  }
}
