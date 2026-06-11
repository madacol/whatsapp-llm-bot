#!/usr/bin/env node
import {
  getDefaultRuntimeDiagnosticsState,
  RUNTIME_DIAGNOSTICS_CONFIG_PATH,
} from "../diagnostics-config.js";

/** @type {Map<string, Array<keyof import("../diagnostics-config.js").RuntimeDiagnosticsConfig>>} */
const TARGETS = new Map([
  ["acp", ["acpProtocolLog"]],
  ["acp-protocol", ["acpProtocolLog"]],
  ["protocol", ["acpProtocolLog"]],
  ["raw", ["rawEventLog"]],
  ["raw-events", ["rawEventLog"]],
  ["events", ["rawEventLog"]],
  ["all", ["acpProtocolLog", "rawEventLog"]],
]);

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
  console.error("Usage: node scripts/diagnostics-logging.js status | <acp|raw|all> <on|off>");
  process.exit(2);
}

const [targetArg, enabledArg] = process.argv.slice(2);
const state = getDefaultRuntimeDiagnosticsState();

if (!targetArg || targetArg === "status") {
  console.log(JSON.stringify({ configPath: RUNTIME_DIAGNOSTICS_CONFIG_PATH, ...state.getConfig() }, null, 2));
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
