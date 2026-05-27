import { createAcpHarness, normalizeAcpHarnessConfig } from "./acp.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ACP_AGENT_ENV_KEY = "MADABOT_ACP_AGENTS_JSON";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_PI_COMMAND = path.join(REPO_ROOT, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi");

/**
 * @typedef {{
 *   name: string,
 *   instanceId: string,
 *   continuationKey: string,
 *   config: Record<string, unknown>,
 *   displayName?: string,
 * }} HarnessDriverCreateInput
 *
 * @typedef {{
 *   availability: "available" | "unavailable" | "unknown" | "maintenance",
 *   message?: string,
 *   checkedAt?: string,
 * }} HarnessDriverStatus
 *
 * @typedef {{
 *   harness: AgentHarness,
 *   status?: HarnessDriverStatus,
 *   adapter?: HarnessAdapter,
 *   textGeneration?: AgentHarness["textGeneration"],
 *   dispose?: () => void | Promise<void>,
 * }} HarnessInstanceBundle
 *
 * @typedef {{
 *   name: string,
 *   displayName?: string,
 *   supportsInstances?: boolean,
 *   docsUrl?: string,
 *   statusUrl?: string,
 *   createInstance: (input: HarnessDriverCreateInput) => HarnessInstanceBundle,
 *   configSchema?: (config: Record<string, unknown>) => Record<string, unknown>,
 *   defaultConfig?: () => Record<string, unknown>,
 * }} HarnessDriver
 */

/** @type {AcpAgentDefinition[]} */
export const BUILT_IN_ACP_AGENT_DEFINITIONS = [
  {
    name: "codex",
    displayName: "Codex",
    command: "codex-acp",
    docsUrl: "https://github.com/agentclientprotocol/codex-acp",
    sessionKind: "codex",
  },
  {
    name: "claude",
    displayName: "Claude",
    command: "claude-agent-acp",
    docsUrl: "https://github.com/agentclientprotocol/claude-agent-acp",
    statusUrl: "https://status.anthropic.com/",
    sessionKind: "claude",
  },
  {
    name: "pi",
    displayName: "Pi",
    command: "pi-acp",
    env: {
      PI_ACP_PI_COMMAND: LOCAL_PI_COMMAND,
    },
    docsUrl: "https://github.com/svkozak/pi-acp",
    sessionKind: "pi",
  },
];

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeArgs(value) {
  return Array.isArray(value)
    ? value.filter((entry) => typeof entry === "string")
    : [];
}

/**
 * @param {unknown} value
 * @returns {Record<string, string> | undefined}
 */
function normalizeEnv(value) {
  if (!isRecord(value)) {
    return undefined;
  }
  /** @type {Record<string, string>} */
  const env = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string") {
      env[key] = raw;
    }
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`ACP agent definition requires a non-empty ${field}.`);
  }
  return value.trim();
}

/**
 * @param {unknown} value
 * @returns {HarnessSessionRef["kind"] | undefined}
 */
function normalizeSessionKind(value) {
  return typeof value === "string" && value.trim()
    ? /** @type {HarnessSessionRef["kind"]} */ (value.trim())
    : undefined;
}

/**
 * @param {unknown} value
 * @returns {AcpAgentDefinition}
 */
export function normalizeAcpAgentDefinition(value) {
  if (!isRecord(value)) {
    throw new Error("ACP agent definition must be an object.");
  }
  const name = requireNonEmptyString(value.name, "name");
  const displayName = typeof value.displayName === "string" && value.displayName.trim()
    ? value.displayName.trim()
    : name;
  const command = requireNonEmptyString(value.command, "command");
  const sessionKind = normalizeSessionKind(value.sessionKind);
  const env = normalizeEnv(value.env);
  return {
    name,
    displayName,
    command,
    args: normalizeArgs(value.args),
    ...(env ? { env } : {}),
    ...(typeof value.docsUrl === "string" && value.docsUrl.trim()
      ? { docsUrl: value.docsUrl.trim() }
      : {}),
    ...(typeof value.statusUrl === "string" && value.statusUrl.trim()
      ? { statusUrl: value.statusUrl.trim() }
      : {}),
    ...(typeof value.supportsInstances === "boolean"
      ? { supportsInstances: value.supportsInstances }
      : {}),
    ...(sessionKind
      ? { sessionKind }
      : {}),
  };
}

/**
 * @param {unknown} value
 * @returns {AcpAgentDefinition[]}
 */
export function normalizeAcpAgentDefinitions(value) {
  if (!Array.isArray(value)) {
    throw new Error("ACP agent definitions must be an array.");
  }
  return value.map(normalizeAcpAgentDefinition);
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {AcpAgentDefinition[]}
 */
export function readAcpAgentDefinitionsFromEnv(env = process.env) {
  const raw = env[ACP_AGENT_ENV_KEY];
  if (!raw?.trim()) {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${ACP_AGENT_ENV_KEY} is not valid JSON: ${message}`);
  }
  return normalizeAcpAgentDefinitions(parsed);
}

/**
 * @param {AcpAgentDefinition} definition
 * @returns {HarnessDriver}
 */
export function createAcpAgentDriver(definition) {
  const agent = normalizeAcpAgentDefinition(definition);
  return {
    name: agent.name,
    displayName: agent.displayName,
    supportsInstances: agent.supportsInstances ?? true,
    ...(agent.docsUrl ? { docsUrl: agent.docsUrl } : {}),
    ...(agent.statusUrl ? { statusUrl: agent.statusUrl } : {}),
    configSchema: (config) => {
      const normalized = normalizeAcpHarnessConfig(config, agent.command);
      if (!Array.isArray(config.args) && agent.args?.length) {
        normalized.args = [...agent.args];
      }
      if (!isRecord(config.env) && agent.env) {
        normalized.env = { ...agent.env };
      }
      return normalized;
    },
    defaultConfig: () => ({
      command: agent.command,
      args: [...(agent.args ?? [])],
      ...(agent.env ? { env: { ...agent.env } } : {}),
    }),
    createInstance: ({ config, displayName }) => ({
      harness: createAcpHarness({
        name: agent.name,
        label: displayName ?? agent.displayName,
        sessionKind: agent.sessionKind,
        config,
        defaultCommand: agent.command,
      }),
    }),
  };
}
