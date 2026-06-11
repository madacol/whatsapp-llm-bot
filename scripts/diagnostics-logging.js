#!/usr/bin/env node
import {
  getDefaultRuntimeDiagnosticsState,
  RUNTIME_DIAGNOSTICS_CONFIG_PATH,
} from "../diagnostics-config.js";

/** @typedef {Exclude<keyof import("../diagnostics-config.js").RuntimeDiagnosticsConfig, "logLevel">} BooleanDiagnosticKey */

/** @type {Map<string, BooleanDiagnosticKey[]>} */
const TARGETS = new Map([
  ["acp", ["acpProtocolLog"]],
  ["acp-protocol", ["acpProtocolLog"]],
  ["protocol", ["acpProtocolLog"]],
  ["stderr", ["acpStderrLog"]],
  ["acp-stderr", ["acpStderrLog"]],
  ["raw", ["rawEventLog"]],
  ["raw-events", ["rawEventLog"]],
  ["events", ["rawEventLog"]],
  ["db", ["dbCacheLog"]],
  ["db-cache", ["dbCacheLog"]],
  ["whatsapp", ["whatsappUpsertLog", "whatsappReactionLog"]],
  ["upsert", ["whatsappUpsertLog"]],
  ["whatsapp-upsert", ["whatsappUpsertLog"]],
  ["reaction", ["whatsappReactionLog"]],
  ["reactions", ["whatsappReactionLog"]],
  ["whatsapp-reactions", ["whatsappReactionLog"]],
  ["all", ["acpProtocolLog", "acpStderrLog", "rawEventLog", "dbCacheLog", "whatsappUpsertLog", "whatsappReactionLog"]],
]);
const LOG_LEVELS = new Set(["debug", "info", "warn", "error", "silent"]);

/**
 * @param {string | undefined} value
 * @returns {boolean | null}
 */
function parseEnabled(value) {
  switch ((value ?? "").trim().toLowerCase()) {
    case "1":
    case "on":
    case "true":
    case "enable":
    case "enabled":
      return true;
    case "0":
    case "off":
    case "false":
    case "disable":
    case "disabled":
      return false;
    default:
      return null;
  }
}

/**
 * @returns {never}
 */
function usage() {
  console.error("Usage: node scripts/diagnostics-logging.js status | <acp|stderr|raw|db|whatsapp|all> <on|off> | level <debug|info|warn|error|silent|default>");
  process.exit(2);
}

const [targetArg, enabledArg] = process.argv.slice(2);
const state = getDefaultRuntimeDiagnosticsState();

if (!targetArg || targetArg === "status") {
  console.log(JSON.stringify({ configPath: RUNTIME_DIAGNOSTICS_CONFIG_PATH, ...state.getConfig() }, null, 2));
  process.exit(0);
}

if (targetArg === "level" || targetArg === "log-level") {
  const level = (enabledArg ?? "").trim().toLowerCase();
  if (level !== "default" && !LOG_LEVELS.has(level)) {
    usage();
  }
  const next = await state.update({
    logLevel: level === "default" ? null : /** @type {import("../diagnostics-config.js").RuntimeDiagnosticsConfig["logLevel"]} */ (level),
  });
  console.log(JSON.stringify({ configPath: RUNTIME_DIAGNOSTICS_CONFIG_PATH, ...next }, null, 2));
  process.exit(0);
}

const keys = TARGETS.get(targetArg);
const enabled = parseEnabled(enabledArg);
if (!keys || enabled === null) {
  usage();
}

/** @type {Partial<import("../diagnostics-config.js").RuntimeDiagnosticsConfig>} */
const patch = {};
for (const key of keys) {
  patch[key] = enabled;
}

const next = await state.update(patch);
console.log(JSON.stringify({ configPath: RUNTIME_DIAGNOSTICS_CONFIG_PATH, ...next }, null, 2));
