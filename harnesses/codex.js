/**
 * Codex harness — uses the local Codex CLI in non-interactive JSON mode.
 */

import { NO_OP_HOOKS } from "./native.js";
import { extractCodexText, startCodexRun } from "./codex-runner.js";
import { getRootDb } from "../db.js";
import { handleHarnessSessionCommand } from "./session-commands.js";
export { buildCodexExecArgs } from "./codex-runner.js";

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

/** @type {Array<{ id: string, label: string }>} */
const CODEX_MODEL_OPTIONS = [
  { id: "gpt-5-codex", label: "GPT-5 Codex" },
  { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
];

/**
 * @typedef {{
 *   child: import("node:child_process").ChildProcessWithoutNullStreams;
 *   done: Promise<{ result: AgentResult, sessionId: string | null }>;
 *   aborted: boolean;
 * }} ActiveCodexRun
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
 * @returns {boolean}
 */
function isSelectableCodexModel(value) {
  return CODEX_MODEL_OPTIONS.some((option) => option.id === value);
}

/**
 * @param {string} chatId
 * @param {string} arg
 * @returns {Promise<string>}
 */
async function handleModelCommand(chatId, arg) {
  if (arg === "off" || arg === "default" || arg === "none") {
    await updateHarnessConfig(chatId, { model: null });
    return "Codex model reset to default.";
  }
  if (!isSelectableCodexModel(arg)) {
    return `Unknown Codex model \`${arg}\`. Run \`/model\` to choose one of: ${CODEX_MODEL_OPTIONS.map((option) => option.id).join(", ")}`;
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
    return "Codex sandbox reset to default.";
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
 * @returns {Promise<boolean>}
 */
async function handleCodexHarnessCommand(input, cancelActiveQuery) {
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
      await input.context.reply("tool-result", await handleModelCommand(input.chatId, arg.toLowerCase()));
      return true;
    }

    const config = await getHarnessConfig(input.chatId);
    const currentModel = typeof config.model === "string" && isSelectableCodexModel(config.model)
      ? config.model
      : undefined;
    /** @type {SelectOption[]} */
    const modelSelectOptions = [
      ...CODEX_MODEL_OPTIONS.map((option) => ({ id: option.id, label: option.label })),
      { id: "off", label: "Default" },
    ];
    const modelChoice = await input.context.select("Choose Codex model", modelSelectOptions, {
      currentId: currentModel,
    });
    if (modelChoice && modelChoice !== currentModel) {
      await handleModelCommand(input.chatId, modelChoice);
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
    const sandboxMode = typeof config.sandboxMode === "string" ? config.sandboxMode : "default";
    await input.context.reply("tool-result", `Codex sandbox: \`${sandboxMode}\``);
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
 * @returns {AgentHarness}
 */
export function createCodexHarness() {
  /** @type {Map<string, ActiveCodexRun>} */
  const activeRuns = new Map();

  return {
    getName: () => "codex",
    getCapabilities: () => CODEX_HARNESS_CAPABILITIES,
    run,
    handleCommand: (input) => handleCodexHarnessCommand(input, cancel),
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
    active.child.kill("SIGTERM");
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
      child: started.child,
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
