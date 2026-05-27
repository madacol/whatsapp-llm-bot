import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openAcpConnection } from "./acp-client.js";
import { BUILT_IN_ACP_AGENT_DEFINITIONS } from "./acp-agents.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const PROMPT_TEXT = "Reply with exactly: OK. Do not use tools and do not edit files.";

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function record(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/**
 * @param {Promise<unknown>} promise
 * @param {string} label
 * @param {number} timeoutMs
 * @returns {Promise<unknown>}
 */
function withTimeout(promise, label, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

/**
 * @returns {Record<string, unknown>}
 */
function clientCapabilities() {
  return {
    fs: { readTextFile: true, writeTextFile: true },
    terminal: true,
    elicitation: { form: {}, url: {} },
    sessionCapabilities: { resume: {}, fork: {}, steer: {} },
    _meta: {
      subagentMessages: true,
      fileChangeEvents: true,
      sessionUsageRfd: true,
      sessionForkRfd: true,
      liveInputExtension: true,
      sessionReadRfd: true,
      sessionRollbackRfd: true,
    },
  };
}

/**
 * @param {string} target
 * @returns {AcpAgentDefinition[]}
 */
function selectDefinitions(target) {
  if (target === "all") {
    return BUILT_IN_ACP_AGENT_DEFINITIONS;
  }
  const definition = BUILT_IN_ACP_AGENT_DEFINITIONS.find((candidate) => candidate.name === target);
  if (!definition) {
    throw new Error(`Unknown ACP smoke target "${target}". Use: all, codex, claude, pi.`);
  }
  return [definition];
}

/**
 * @param {AcpAgentDefinition} definition
 * @param {{ prompt: boolean, timeoutMs: number }} options
 * @returns {Promise<Record<string, unknown>>}
 */
async function smokeDefinition(definition, options) {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), `madabot-acp-${definition.name}-`));
  /** @type {Awaited<ReturnType<typeof openAcpConnection>> | undefined} */
  let connection;
  try {
    connection = await openAcpConnection({
      command: definition.command,
      args: definition.args ?? [],
      cwd: workdir,
      env: { ...process.env, ...(definition.env ?? {}) },
      handleRequest: async () => ({}),
    });
    const initializeResult = record(await withTimeout(connection.sendRequest("initialize", {
      protocolVersion: 1,
      clientInfo: {
        name: "madabot-smoke",
        title: "Madabot Smoke",
        version: "1.0.0",
      },
      clientCapabilities: clientCapabilities(),
    }), `${definition.name} initialize`, options.timeoutMs));
    const sessionResult = record(await withTimeout(connection.sendRequest("session/new", {
      cwd: workdir,
      mcpServers: [],
      _meta: {
        madabot: {
          sandboxMode: "workspace-write",
          approvalPolicy: "never",
        },
      },
    }), `${definition.name} session/new`, options.timeoutMs));
    const sessionRecord = record(sessionResult.session);
    const sessionId = typeof sessionResult.sessionId === "string"
      ? sessionResult.sessionId
      : sessionRecord.id;
    /** @type {Record<string, unknown> | null} */
    let promptResult = null;
    if (options.prompt) {
      promptResult = record(await withTimeout(connection.sendRequest("session/prompt", {
        ...(typeof sessionId === "string" ? { sessionId } : {}),
        prompt: [{ type: "text", text: PROMPT_TEXT }],
      }), `${definition.name} session/prompt`, options.timeoutMs));
    }
    return {
      name: definition.name,
      ok: true,
      command: definition.command,
      workdir,
      initializeKeys: Object.keys(initializeResult),
      capabilities: initializeResult.agentCapabilities ?? null,
      authMethods: Array.isArray(initializeResult.authMethods)
        ? initializeResult.authMethods.map((method) => record(method).id).filter(Boolean)
        : [],
      sessionKeys: Object.keys(sessionResult),
      sessionId: typeof sessionId === "string" ? sessionId : null,
      ...(promptResult ? { promptKeys: Object.keys(promptResult) } : {}),
    };
  } catch (error) {
    return {
      name: definition.name,
      ok: false,
      command: definition.command,
      workdir,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await connection?.close().catch(() => {});
  }
}

/**
 * @param {{ target?: string, prompt?: boolean, timeoutMs?: number }} [options]
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function runAcpAdapterSmoke(options = {}) {
  const target = options.target ?? "all";
  const definitions = selectDefinitions(target);
  const results = [];
  for (const definition of definitions) {
    results.push(await smokeDefinition(definition, {
      prompt: options.prompt === true,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    }));
  }
  return results;
}
