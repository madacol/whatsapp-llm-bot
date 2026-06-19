import { spawn } from "node:child_process";

export const CODEX_CLI_STATUS_DEFAULT_TIMEOUT_MS = 45_000;
export const CODEX_CLI_STATUS_READY_FALLBACK_MS = 10_000;
export const CODEX_CLI_STATUS_COMMAND_INPUT = "\u0015/status\r";
export const CODEX_CLI_STATUS_SKIP_UPDATE_INPUT = "2\r";
export const CODEX_CLI_STATUS_DEFAULT_PROMPT_INPUT = "\r";
const DEFAULT_INITIAL_INPUT_DELAY_MS = CODEX_CLI_STATUS_READY_FALLBACK_MS;
const FALLBACK_ENTER_DELAY_MS = 1_000;
const STATUS_PTY_COLUMNS = 100;
const STATUS_PTY_ROWS = 30;
const MAX_FAILURE_OUTPUT_CHARS = 2_000;

/**
 * @typedef {{
 *   command?: string,
 *   args?: string[],
 *   workdir?: string,
 *   env?: NodeJS.ProcessEnv,
 *   timeoutMs?: number,
 *   initialInputDelayMs?: number,
 * }} CodexCliStatusOptions
 */

/**
 * @typedef {{
 *   model?: string,
 *   directory?: string,
 *   permissions?: string,
 *   agentsMd?: string,
 *   account?: string,
 *   collaborationMode?: string,
 *   session?: string,
 *   limits: Array<{ label: string, value: string }>,
 * }} ParsedCodexStatus
 */

/**
 * @param {string} value
 * @returns {string}
 */
function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * @param {string} command
 * @param {string[]} args
 * @returns {string}
 */
function buildCommandLine(command, args) {
  return [command, ...args].map(shellQuote).join(" ");
}

/**
 * @param {string} output
 * @returns {string}
 */
export function stripTerminalControl(output) {
  return output
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B[@-Z\\-_]/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

/**
 * @param {string} output
 * @returns {string[]}
 */
function getPlainTerminalLines(output) {
  return stripTerminalControl(output)
    .replace(/\r(?!\n)/g, "\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * @param {string[]} lines
 * @param {(line: string) => boolean} predicate
 * @returns {number}
 */
function findLastLineIndex(lines, predicate) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (predicate(lines[index] ?? "")) {
      return index;
    }
  }
  return -1;
}

/**
 * Detect when the interactive Codex terminal has rendered its input prompt.
 * The prompt marker alone is not enough; terminal output can contain that
 * glyph in older content. Require the Codex shell header and a trailing prompt
 * line so `/status` is sent only after the UI is actually ready.
 * @param {string} output
 * @returns {boolean}
 */
export function isCodexCliReadyForInput(output) {
  const lines = getPlainTerminalLines(output);
  const codexHeaderIndex = findLastLineIndex(lines, (line) => line.includes("OpenAI Codex"));
  if (codexHeaderIndex === -1) {
    return false;
  }
  const tail = lines.slice(codexHeaderIndex + 1);
  const promptIndex = findLastLineIndex(tail, (line) => /^›(?:\s|$)/.test(line));
  if (promptIndex === -1) {
    return false;
  }
  const afterPrompt = tail.slice(promptIndex + 1);
  return !afterPrompt.some((line) => /^(?:[•◦]\s*)?(?:Loading|Booting)\b/i.test(line));
}

/**
 * Detect Codex startup prompts that block the input shell before `/status` can
 * be sent. The caller should answer with Enter only, which chooses the safe
 * default for repair prompts and continues past update notices.
 * @param {string} output
 * @returns {boolean}
 */
export function isCodexCliStartupPromptWaiting(output) {
  return getCodexCliStartupPromptResponse(output) !== null;
}

/**
 * @param {string} output
 * @returns {string | null}
 */
export function getCodexCliStartupPromptResponse(output) {
  const plain = getPlainTerminalLines(output).join("\n");
  if (/Update available!/i.test(plain) && /Press enter to continue/i.test(plain)) {
    return CODEX_CLI_STATUS_SKIP_UPDATE_INPUT;
  }
  if (/Repair Codex local data now\?\s*\[y\/N\]:/i.test(plain)) {
    return CODEX_CLI_STATUS_DEFAULT_PROMPT_INPUT;
  }
  return null;
}

/**
 * @param {string} line
 * @returns {string | null}
 */
function extractBoxLineContent(line) {
  const first = line.indexOf("│");
  const last = line.lastIndexOf("│");
  if (first === -1 || last <= first) {
    return null;
  }
  return line
    .slice(first + 1, last)
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {string[]} lines
 * @param {number} startIndex
 * @returns {number}
 */
function findNextCodexPanelStart(lines, startIndex) {
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (lines[index]?.includes("OpenAI Codex")) {
      return index;
    }
  }
  return lines.length;
}

/**
 * @param {string[]} lines
 * @param {number} startIndex
 * @param {number} endIndex
 * @returns {boolean}
 */
function panelLooksLikeStatus(lines, startIndex, endIndex) {
  const panel = lines.slice(startIndex, endIndex).join("\n");
  const weeklyLimitCount = panel.match(/Weekly limit:/g)?.length ?? 0;
  return /Model:/i.test(panel)
    && /(?:Account|Session):/i.test(panel)
    && /(?:5h limit|Weekly limit):/i.test(panel)
    && weeklyLimitCount >= (panel.includes("GPT-5.3-Codex-Spark limit:") ? 2 : 1);
}

/**
 * @param {string[]} lines
 * @param {number} startIndex
 * @param {number} endIndex
 * @returns {boolean}
 */
function panelLooksLikePotentialStatus(lines, startIndex, endIndex) {
  const panel = lines.slice(startIndex, endIndex).join("\n");
  return /(?:Session|Usage|limit):/i.test(panel);
}

/**
 * @param {string} output
 * @returns {string}
 */
export function summarizeCodexStatusFailureOutput(output) {
  const plain = getPlainTerminalLines(output).join("\n").trim();
  if (!plain) {
    return "";
  }
  const clipped = plain.length > MAX_FAILURE_OUTPUT_CHARS
    ? `...${plain.slice(-MAX_FAILURE_OUTPUT_CHARS)}`
    : plain;
  return `\n\nLast Codex CLI output:\n${clipped}`;
}

/**
 * @param {string} value
 * @returns {string}
 */
function stripLimitBar(value) {
  return value.replace(/^\[[^\]]+\]\s*/, "").trim();
}

/**
 * @param {string} label
 * @param {string} value
 * @returns {{ label: string, value: string } | null}
 */
function parseLimitLine(label, value) {
  if (!/limit$/i.test(label)) {
    return null;
  }
  const stripped = stripLimitBar(value);
  return stripped ? { label, value: stripped } : null;
}

/**
 * @param {string} label
 * @param {string} value
 * @returns {{ key: keyof Omit<ParsedCodexStatus, "limits">, value: string } | null}
 */
function parseStatusField(label, value) {
  const normalized = label.toLowerCase();
  if (normalized === "model") return { key: "model", value };
  if (normalized === "directory") return { key: "directory", value };
  if (normalized === "permissions") return { key: "permissions", value };
  if (normalized === "agents.md") return { key: "agentsMd", value };
  if (normalized === "account") return { key: "account", value };
  if (normalized === "collaboration mode") return { key: "collaborationMode", value };
  if (normalized === "session") return { key: "session", value };
  return null;
}

/**
 * @param {ParsedCodexStatus} status
 * @returns {boolean}
 */
function hasEnoughStatusFields(status) {
  return !!status.model
    && !!status.account
    && !!status.session
    && status.limits.length > 0;
}

/**
 * Parse the cleaned Codex CLI /status panel into semantic fields.
 * @param {string} statusPanel
 * @returns {ParsedCodexStatus | null}
 */
export function parseCodexStatusPanel(statusPanel) {
  /** @type {ParsedCodexStatus} */
  const parsed = { limits: [] };
  let limitGroup = "";

  for (const rawLine of statusPanel.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(">_ ") || /^Visit\b/i.test(line) || /^information\b/i.test(line)) {
      continue;
    }

    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (!match) {
      continue;
    }
    const label = match[1]?.trim() ?? "";
    const value = match[2]?.trim() ?? "";
    if (!label) {
      continue;
    }

    if (!value && /limit$/i.test(label)) {
      limitGroup = label.replace(/\s+limit$/i, "").trim();
      continue;
    }

    const limit = parseLimitLine(limitGroup ? `${limitGroup} ${label}` : label, value);
    if (limit) {
      parsed.limits.push(limit);
      continue;
    }

    const field = parseStatusField(label, value);
    if (field && field.value) {
      parsed[field.key] = field.value;
      limitGroup = "";
    }
  }

  return hasEnoughStatusFields(parsed) ? parsed : null;
}

/**
 * Extract the Codex CLI /status panel from captured terminal output.
 * @param {string} output
 * @returns {string}
 */
export function extractCodexStatusPanel(output) {
  /** @type {string[]} */
  const boxLines = [];
  for (const rawLine of stripTerminalControl(output).split(/\r?\n/)) {
    const line = extractBoxLineContent(rawLine);
    if (line) {
      boxLines.push(line);
    }
  }

  const codexStarts = boxLines
    .map((line, index) => line.includes("OpenAI Codex") ? index : -1)
    .filter((index) => index >= 0);

  for (let i = codexStarts.length - 1; i >= 0; i -= 1) {
    const start = codexStarts[i];
    const end = findNextCodexPanelStart(boxLines, start);
    if (panelLooksLikeStatus(boxLines, start, end)) {
      return boxLines.slice(start, end).join("\n").trim();
    }
    if (panelLooksLikePotentialStatus(boxLines, start, end)) {
      return boxLines.slice(start, end).join("\n").trim();
    }
  }

  throw new Error("Codex CLI /status output did not contain a status panel.");
}

/**
 * @param {string} statusPanel
 * @returns {string}
 */
export function formatCodexStatusForReply(statusPanel) {
  const parsed = parseCodexStatusPanel(statusPanel);
  if (!parsed) {
    return `Codex status:\n\`\`\`\n${statusPanel.trim()}\n\`\`\``;
  }

  const lines = [
    "Codex status:",
    `**Model:** ${parsed.model}`,
    ...(parsed.directory ? [`**Directory:** ${parsed.directory}`] : []),
    ...(parsed.permissions ? [`**Permissions:** ${parsed.permissions}`] : []),
    ...(parsed.agentsMd ? [`**Agents.md:** ${parsed.agentsMd}`] : []),
    `**Account:** ${parsed.account}`,
    ...(parsed.collaborationMode ? [`**Collaboration mode:** ${parsed.collaborationMode}`] : []),
    `**Session:** \`${parsed.session}\``,
    "",
    ...parsed.limits.map((limit) => `**${limit.label}:** ${limit.value}`),
  ];
  return lines.join("\n");
}

/**
 * Run a fresh Codex CLI, submit /status in its terminal UI, and return the rendered status panel.
 * @param {CodexCliStatusOptions} [options]
 * @returns {Promise<string>}
 */
export async function readCodexCliStatus(options = {}) {
  const command = options.command ?? "codex";
  const args = [
    "--no-alt-screen",
    ...(options.workdir ? ["-C", options.workdir] : []),
    ...(options.args ?? []),
  ];
  const timeoutMs = options.timeoutMs ?? CODEX_CLI_STATUS_DEFAULT_TIMEOUT_MS;
  const initialInputDelayMs = options.initialInputDelayMs ?? DEFAULT_INITIAL_INPUT_DELAY_MS;
  const commandLine = `stty cols ${STATUS_PTY_COLUMNS} rows ${STATUS_PTY_ROWS}; exec ${buildCommandLine(command, args)}`;
  const child = spawn("script", ["-qfec", commandLine, "/dev/null"], {
    cwd: options.workdir ?? process.cwd(),
    env: { ...process.env, TERM: "xterm-256color", ...(options.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    let sentStatus = false;
    let answeredStartupPrompt = false;
    let buffer = "";
    /** @type {NodeJS.Timeout | null} */
    let inputTimer = null;
    /** @type {NodeJS.Timeout | null} */
    let fallbackEnterTimer = null;
    /** @type {NodeJS.Timeout | null} */
    let timeoutTimer = null;

    const cleanup = () => {
      if (inputTimer) clearTimeout(inputTimer);
      if (fallbackEnterTimer) clearTimeout(fallbackEnterTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };

    /**
     * @param {string} statusPanel
     */
    const finish = (statusPanel) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!child.killed) {
        child.stdin.write("\u0003");
        child.kill("SIGTERM");
      }
      resolve(statusPanel);
    };

    /**
     * @param {Error} error
     */
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!child.killed) {
        child.kill("SIGTERM");
      }
      reject(error);
    };

    const sendStatus = () => {
      if (sentStatus || !child.stdin.writable) {
        return;
      }
      sentStatus = true;
      child.stdin.write(CODEX_CLI_STATUS_COMMAND_INPUT);
      fallbackEnterTimer = setTimeout(() => {
        if (!settled && child.stdin.writable) {
          child.stdin.write("\r");
        }
      }, FALLBACK_ENTER_DELAY_MS);
    };

    /**
     * @param {Buffer | string} chunk
     */
    function onData(chunk) {
      buffer += chunk.toString();
      const startupPromptResponse = getCodexCliStartupPromptResponse(buffer);
      if (!sentStatus && !answeredStartupPrompt && startupPromptResponse !== null) {
        answeredStartupPrompt = true;
        if (child.stdin.writable) {
          child.stdin.write(startupPromptResponse);
        }
        return;
      }
      if (!sentStatus && isCodexCliReadyForInput(buffer)) {
        sendStatus();
      }
      if (!sentStatus) {
        return;
      }
      try {
        const panel = extractCodexStatusPanel(buffer);
        finish(panel);
      } catch {
        // Keep collecting until the full panel has rendered or the timeout fires.
      }
    }

    /**
     * @param {Error} error
     */
    function onError(error) {
      fail(error);
    }

    /**
     * @param {number | null} code
     * @param {NodeJS.Signals | null} signal
     */
    function onExit(code, signal) {
      if (settled) {
        return;
      }
      fail(new Error(`Codex CLI /status exited before rendering status (code ${code ?? "null"}, signal ${signal ?? "null"}).${summarizeCodexStatusFailureOutput(buffer)}`));
    }

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", onError);
    child.on("exit", onExit);
    inputTimer = setTimeout(sendStatus, initialInputDelayMs);
    timeoutTimer = setTimeout(() => {
      fail(new Error(sentStatus
        ? `Timed out waiting for Codex CLI /status output.${summarizeCodexStatusFailureOutput(buffer)}`
        : `Timed out waiting for Codex CLI to become ready for /status input.${summarizeCodexStatusFailureOutput(buffer)}`));
    }, timeoutMs);
  });
}
