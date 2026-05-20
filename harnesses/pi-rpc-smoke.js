import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openPiRpcConnection } from "./pi-rpc-client.js";

/**
 * @typedef {{
 *   root: string,
 *   eventPath: string,
 *   model: string,
 *   generatedText: string | null,
 *   observedToolNames: unknown[],
 *   writeCompleted: boolean,
 *   failedBashCompleted: boolean,
 *   toolEvents: Array<Record<string, unknown>>,
 * }} PiRpcSmokeSummary
 */

/**
 * @param {string[]} argv
 * @param {string} name
 * @returns {string | null}
 */
function readOption(argv, name) {
  const prefix = `--${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  if (inline) {
    return inline.slice(prefix.length);
  }
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] ?? null : null;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function summarizeArgs(value) {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (typeof entry !== "string") {
      return [key, Array.isArray(entry) ? `array(${entry.length})` : typeof entry];
    }
    if (key === "content") {
      return [key, `${entry.length} chars`];
    }
    return [key, entry.length > 120 ? `${entry.slice(0, 117)}...` : entry];
  }));
}

/**
 * @param {Record<string, unknown>[]} events
 * @returns {Array<Record<string, unknown>>}
 */
function summarizeToolEvents(events) {
  return events
    .filter((event) => typeof event.type === "string" && event.type.startsWith("tool_execution_"))
    .map((event) => ({
      type: event.type,
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      argKeys: isRecord(event.args) ? Object.keys(event.args).sort() : [],
      args: summarizeArgs(event.args),
      resultKeys: isRecord(event.result) ? Object.keys(event.result).sort() : [],
      partialResultKeys: isRecord(event.partialResult) ? Object.keys(event.partialResult).sort() : [],
      ...(typeof event.isError === "boolean" ? { isError: event.isError } : {}),
    }));
}

/**
 * @param {{ argv?: string[], env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<PiRpcSmokeSummary>}
 */
export async function runPiRpcSmoke(options = {}) {
  const argv = options.argv ?? process.argv;
  const env = options.env ?? process.env;
  const model = readOption(argv, "model") ?? "google/gemini-2.5-flash";
  const [provider, modelId] = model.includes("/") ? model.split("/", 2) : ["google", model];
  const root = readOption(argv, "root") ?? await fs.mkdtemp(path.join(os.tmpdir(), "pi-rpc-smoke-"));
  const workdir = path.join(root, "work");
  const piHome = path.join(root, "pi-home");
  await fs.mkdir(path.join(workdir, "nested"), { recursive: true });
  await fs.writeFile(path.join(workdir, "alpha.txt"), "alpha\nneedle_rpc_smoke\n", "utf8");
  await fs.writeFile(path.join(workdir, "target.txt"), "old_value\n", "utf8");
  await fs.writeFile(path.join(workdir, "nested", "beta.target"), "beta\n", "utf8");

  const connection = await openPiRpcConnection({
    cwd: workdir,
    env: {
      ...env,
      PI_CODING_AGENT_DIR: piHome,
    },
  });

  /** @type {Record<string, unknown>[]} */
  const events = [];
  const timeout = setTimeout(() => {
    void connection.close();
  }, Number(readOption(argv, "timeout-ms") ?? 180_000));

  try {
    const setModel = await connection.sendRequest({
      id: "model",
      type: "set_model",
      provider,
      modelId,
    });
    if (setModel.success !== true) {
      throw new Error(`set_model failed: ${JSON.stringify(setModel)}`);
    }

    const thinking = await connection.sendRequest({ id: "thinking", type: "set_thinking_level", level: "off" });
    if (thinking.success !== true) {
      throw new Error(`set_thinking_level failed: ${JSON.stringify(thinking)}`);
    }

    const prompt = await connection.sendRequest({
      id: "prompt",
      type: "prompt",
      message: [
        "This is a disposable Pi RPC smoke test.",
        "Perform these steps in order:",
        "1. Read target.txt.",
        "2. List the current directory.",
        "3. Search for needle_rpc_smoke.",
        "4. Find files matching *.target.",
        "5. Write generated.txt with exactly: generated smoke content",
        "6. Run this bash command exactly: cat missing-file-for-rpc-smoke",
        "Then answer exactly: DONE",
      ].join("\n"),
    });
    if (prompt.success !== true) {
      throw new Error(`prompt failed: ${JSON.stringify(prompt)}`);
    }

    for await (const event of connection.notifications) {
      events.push(event);
      if (event.type === "agent_end") {
        break;
      }
    }
  } finally {
    clearTimeout(timeout);
    await connection.close();
  }

  const eventPath = path.join(root, "events.jsonl");
  await fs.writeFile(eventPath, events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");

  let generatedText = null;
  try {
    generatedText = await fs.readFile(path.join(workdir, "generated.txt"), "utf8");
  } catch {
    generatedText = null;
  }

  const toolEvents = summarizeToolEvents(events);
  const observedToolNames = [...new Set(toolEvents.map((event) => event.toolName).filter(Boolean))].sort();
  const failedTools = toolEvents.filter((event) => event.type === "tool_execution_end" && event.isError === true);
  const writeCompleted = toolEvents.some((event) => event.type === "tool_execution_end" && event.toolName === "write");
  const failedBashCompleted = failedTools.some((event) => event.toolName === "bash");

  return {
    root,
    eventPath,
    model: `${provider}/${modelId}`,
    generatedText,
    observedToolNames,
    writeCompleted,
    failedBashCompleted,
    toolEvents,
  };
}

/**
 * @returns {Promise<void>}
 */
export async function runPiRpcSmokeCli() {
  const summary = await runPiRpcSmoke();
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.writeCompleted || !summary.failedBashCompleted) {
    process.exitCode = 2;
  }
}
