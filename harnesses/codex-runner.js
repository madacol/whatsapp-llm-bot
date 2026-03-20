import { spawn as spawnChild } from "node:child_process";
import { mkdtemp as makeTempDir, readFile as readTextFile, rm as removeDir } from "node:fs/promises";
import { tmpdir as resolveSystemTmpDir } from "node:os";
import path from "node:path";
import { createInterface as createLineReader } from "node:readline";
import { createLogger } from "../logger.js";
import { errorToString } from "../utils.js";
import { extractCodexText, normalizeCodexEvent } from "./codex-events.js";

const log = createLogger("harness:codex-runner");

/** @type {Pick<Required<AgentIOHooks>, "onCommand" | "onPlan" | "onFileChange" | "onLlmResponse" | "onToolError" | "onUsage">} */
const DEFAULT_CODEX_RUN_HOOKS = {
  onCommand: async () => {},
  onPlan: async () => {},
  onFileChange: async () => {},
  onLlmResponse: async () => {},
  onToolError: async () => {},
  onUsage: async () => {},
};

/**
 * @typedef {{
 *   spawn?: typeof spawnChild,
 *   mkdtemp?: typeof makeTempDir,
 *   readFile?: typeof readTextFile,
 *   rm?: typeof removeDir,
 *   createInterface?: typeof createLineReader,
 *   tmpdir?: typeof resolveSystemTmpDir,
 * }} CodexRunnerDeps
 */

/**
 * @typedef {{
 *   result: AgentResult,
 *   sessionId: string | null,
 * }} CompletedCodexRun
 */

/**
 * Build the Codex CLI argument vector for a run.
 * Prompt text is sent via stdin using `-` so leading dashes in user content are
 * never parsed as CLI flags.
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
 * @param {number} value
 * @returns {string}
 */
function formatUsageCost(value) {
  return value.toFixed(6);
}

/**
 * Start a Codex CLI run and stream semantic events into harness hooks.
 * @param {{
 *   chatId: string,
 *   prompt: string,
 *   messages: Message[],
 *   sessionId?: string | null,
 *   runConfig?: HarnessRunConfig,
 *   hooks?: Pick<AgentIOHooks, "onCommand" | "onPlan" | "onFileChange" | "onLlmResponse" | "onToolError" | "onUsage">,
 *   isAborted?: () => boolean,
 * }} input
 * @param {CodexRunnerDeps} [deps]
 * @returns {Promise<{
 *   child: import("node:child_process").ChildProcessWithoutNullStreams,
 *   done: Promise<CompletedCodexRun>,
 * }>}
 */
export async function startCodexRun(input, deps = {}) {
  const spawn = deps.spawn ?? spawnChild;
  const mkdtemp = deps.mkdtemp ?? makeTempDir;
  const readFile = deps.readFile ?? readTextFile;
  const rm = deps.rm ?? removeDir;
  const createInterface = deps.createInterface ?? createLineReader;
  const tmpdir = deps.tmpdir ?? resolveSystemTmpDir;
  const hooks = { ...DEFAULT_CODEX_RUN_HOOKS, ...input.hooks };

  const tempDir = await mkdtemp(path.join(tmpdir(), "codex-harness-"));
  const outputLastMessagePath = path.join(tempDir, "last-message.txt");
  const args = buildCodexExecArgs({
    prompt: input.prompt,
    sessionId: input.sessionId,
    runConfig: input.runConfig,
    outputLastMessagePath,
  });

  log.info(`Starting Codex run for chat ${input.chatId}: codex ${args.join(" ")}`);

  /** @type {AgentResult} */
  const result = {
    response: [],
    messages: input.messages,
    usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
  };

  let resolvedSessionId = input.sessionId ?? null;
  let lastAssistantText = null;
  /** @type {string[]} */
  const stderrLines = [];
  /** @type {string | null} */
  let failureMessage = null;

  const child = spawn("codex", args, {
    cwd: input.runConfig?.workdir ?? process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stdin.write(input.prompt);
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

  const done = (async () => {
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

    try {
      const finalText = (await readFile(outputLastMessagePath, "utf8").catch(() => "")) || lastAssistantText || "";
      if (finalText) {
        result.response = [{ type: "markdown", text: finalText }];
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }

    if (input.isAborted?.()) {
      return { result, sessionId: resolvedSessionId };
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

    return { result, sessionId: resolvedSessionId };
  })();

  return { child, done };
}

export { extractCodexText };
