/**
 * Codex harness — uses the local Codex CLI in non-interactive JSON mode.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import os from "node:os";
import { NO_OP_HOOKS } from "./native.js";
import { extractCodexText, normalizeCodexEvent } from "./codex-events.js";
import { createLogger } from "../logger.js";
import { errorToString } from "../utils.js";
import { getRootDb } from "../db.js";
import { handleHarnessSessionCommand } from "./session-commands.js";

const log = createLogger("harness:codex");

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

/**
 * @typedef {{
 *   child: import("node:child_process").ChildProcessWithoutNullStreams;
 *   done: Promise<void>;
 *   aborted: boolean;
 * }} ActiveCodexRun
 */

/**
 * Build the Codex CLI argument vector for a run.
 * Prompts are always sent via stdin using `-` so message text that starts with `-`
 * is never parsed as an option.
 * @param {{
 *   prompt: string,
 *   sessionId?: string | null,
 *   runConfig?: HarnessRunConfig,
 *   outputLastMessagePath: string,
 * }} input
 * @returns {string[]}
 */
export function buildCodexExecArgs({ prompt, sessionId, runConfig, outputLastMessagePath }) {
  /** @type {string[]} */
  const args = [];

  if (runConfig?.model) {
    args.push("-m", runConfig.model);
  }
  if (runConfig?.sandboxMode) {
    args.push("-s", runConfig.sandboxMode);
  }
  if (runConfig?.approvalPolicy) {
    args.push("-a", runConfig.approvalPolicy);
  }
  if (runConfig?.workdir) {
    args.push("-C", runConfig.workdir);
  }

  args.push("exec");

  if (sessionId) {
    args.push("resume", sessionId);
  }

  args.push("--json", "--skip-git-repo-check", "--output-last-message", outputLastMessagePath, prompt ? "-" : "");

  return args.filter(Boolean);
}

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
 * @param {number} value
 * @returns {string}
 */
function formatUsageCost(value) {
  return value.toFixed(6);
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
 * @param {string} chatId
 * @param {string} arg
 * @returns {Promise<string>}
 */
async function handleModelCommand(chatId, arg) {
  if (arg === "off" || arg === "default" || arg === "none") {
    await updateHarnessConfig(chatId, { model: null });
    return "Codex model reset to default.";
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
    const currentModel = typeof config.model === "string" ? config.model : "default";
    await input.context.reply("tool-result", `Codex model: \`${currentModel}\``);
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
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-harness-"));
    const outputLastMessagePath = path.join(tempDir, "last-message.txt");
    const args = buildCodexExecArgs({
      prompt,
      sessionId,
      runConfig,
      outputLastMessagePath,
    });

    log.info(`Starting Codex run for chat ${session.chatId}: codex ${args.join(" ")}`);

    /** @type {AgentResult} */
    const result = {
      response: [],
      messages,
      usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
    };

    let resolvedSessionId = sessionId;
    let lastAssistantText = null;
    /** @type {string[]} */
    const stderrLines = [];
    /** @type {string | null} */
    let failureMessage = null;

    const child = spawn("codex", args, {
      cwd: runConfig?.workdir ?? process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    /** @type {(value?: void | PromiseLike<void>) => void} */
    let resolveDone = () => {};
    const done = new Promise((resolve) => {
      resolveDone = resolve;
    });
    activeRuns.set(session.chatId, {
      child,
      done,
      aborted: false,
    });

    child.stdin.write(prompt);
    child.stdin.end();

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderrLines.push(text);
      if (stderrLines.length > 100) {
        stderrLines.shift();
      }
      log.debug("[codex stderr]", text.trimEnd());
    });

    const stdout = createInterface({ input: child.stdout });
    let eventQueue = Promise.resolve();
    stdout.on("line", (line) => {
      eventQueue = eventQueue.then(async () => {
        try {
          const normalized = normalizeCodexEvent(JSON.parse(line));
          if (!normalized) {
            return;
          }

          if (normalized.sessionId) {
            resolvedSessionId = normalized.sessionId;
          }

          if (normalized.usage) {
            result.usage = normalized.usage;
          }

          if (normalized.failureMessage) {
            failureMessage = normalized.failureMessage;
          }

          if (normalized.commandEvent) {
            await hooks.onCommand(normalized.commandEvent);
          }

          if (normalized.assistantText) {
            lastAssistantText = normalized.assistantText;
            await hooks.onLlmResponse(normalized.assistantText);
          }

          if (normalized.planText) {
            await hooks.onPlan(normalized.planText);
          }

          if (normalized.fileChange) {
            await hooks.onFileChange(normalized.fileChange);
          }
        } catch (error) {
          log.warn("Failed to parse Codex JSON event:", errorToString(error));
        }
      });
    });

    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    }).catch((error) => {
      const err = /** @type {NodeJS.ErrnoException} */ (error);
      if (err.code === "ENOENT") {
        throw new Error("Codex CLI is not installed or not on PATH.");
      }
      throw error;
    });

    await eventQueue;

    const active = activeRuns.get(session.chatId);
    const aborted = active?.aborted ?? false;
    activeRuns.delete(session.chatId);
    resolveDone();

    try {
      const finalText = (await readFile(outputLastMessagePath, "utf8").catch(() => "")) || lastAssistantText || "";
      if (finalText) {
        result.response = [{ type: "markdown", text: finalText }];
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }

    if (resolvedSessionId && resolvedSessionId !== sessionId) {
      await saveCodexSessionId(session, resolvedSessionId);
    }

    if (aborted) {
      return result;
    }

    if (failureMessage) {
      await hooks.onToolError(failureMessage);
      throw new Error(failureMessage);
    }

    if (exitCode !== 0) {
      const stderrTail = stderrLines.join("").trim();
      const errorMessage = stderrTail || `Codex exited with code ${exitCode}`;
      await hooks.onToolError(errorMessage);
      throw new Error(errorMessage);
    }

    if (result.usage.promptTokens > 0 || result.usage.completionTokens > 0 || result.usage.cachedTokens > 0) {
      await hooks.onUsage(formatUsageCost(result.usage.cost), {
        prompt: result.usage.promptTokens,
        completion: result.usage.completionTokens,
        cached: result.usage.cachedTokens,
      });
    }

    return result;
  }
}
