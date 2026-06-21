#!/usr/bin/env node
import {
  getDefaultRuntimeDiagnosticsState,
  RUNTIME_DIAGNOSTICS_CONFIG_PATH,
} from "../diagnostics-config.js";

const LOG_LEVELS = new Set(["debug", "info", "warn", "error", "silent"]);
const DEFAULT_CAPTURE_MINUTES = 5;

/**
 * @returns {never}
 */
function usage() {
  console.error([
    "Usage:",
    "  node scripts/diagnostics-logging.js status",
    "  node scripts/diagnostics-logging.js level <debug|info|warn|error|silent|default>",
    "  node scripts/diagnostics-logging.js capture status",
    "  node scripts/diagnostics-logging.js capture <seam|all> off",
    "  node scripts/diagnostics-logging.js capture <seam> on [--minutes N] [--rotate-minutes N] [--retention-hours N] [--queue-limit N]",
    "  node scripts/diagnostics-logging.js capture <seam> full-raw [--minutes N]",
  ].join("\n"));
  process.exit(2);
}

/**
 * @param {string[]} args
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function numberOption(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) {
    return fallback;
  }
  const value = Number(args[index + 1]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * @param {number} minutes
 * @returns {string}
 */
function minutesFromNowIso(minutes) {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

/**
 * @param {import("../diagnostics-config.js").RuntimeDiagnosticsConfig} config
 * @returns {import("../diagnostics-config.js").RuntimeDiagnosticsConfig}
 */
function cloneConfig(config) {
  return JSON.parse(JSON.stringify(config));
}

const [targetArg, subArg, ...restArgs] = process.argv.slice(2);
const state = getDefaultRuntimeDiagnosticsState();

if (!targetArg || targetArg === "status") {
  console.log(JSON.stringify({ configPath: RUNTIME_DIAGNOSTICS_CONFIG_PATH, ...state.getConfig() }, null, 2));
  process.exit(0);
}

if (targetArg === "level" || targetArg === "log-level") {
  const level = (subArg ?? "").trim().toLowerCase();
  if (level !== "default" && !LOG_LEVELS.has(level)) {
    usage();
  }
  const next = await state.update({
    logLevel: level === "default" ? null : /** @type {import("../diagnostics-config.js").RuntimeDiagnosticsConfig["logLevel"]} */ (level),
  });
  console.log(JSON.stringify({ configPath: RUNTIME_DIAGNOSTICS_CONFIG_PATH, ...next }, null, 2));
  process.exit(0);
}

if (targetArg !== "capture") {
  usage();
}

if (!subArg || subArg === "status") {
  console.log(JSON.stringify({ configPath: RUNTIME_DIAGNOSTICS_CONFIG_PATH, capture: state.getConfig().capture }, null, 2));
  process.exit(0);
}

const seam = subArg;
const command = restArgs.shift();
if (!command) {
  usage();
}

const current = cloneConfig(state.getConfig());
current.capture ??= { seams: {} };
current.capture.seams ??= {};

if (command === "off") {
  if (seam === "all") {
    current.capture.seams = {};
  } else {
    delete current.capture.seams[seam];
  }
  const next = await state.update(current);
  console.log(JSON.stringify({ configPath: RUNTIME_DIAGNOSTICS_CONFIG_PATH, ...next }, null, 2));
  process.exit(0);
}

if (seam === "all") {
  usage();
}

const minutes = numberOption(restArgs, "--minutes", DEFAULT_CAPTURE_MINUTES);
const seamConfig = {
  ...(current.capture.seams[seam] ?? {}),
};

if (command === "on") {
  seamConfig.enabledUntil = minutesFromNowIso(minutes);
  const rotateMinutes = numberOption(restArgs, "--rotate-minutes", seamConfig.rotateMinutes ?? 1);
  const retentionHours = numberOption(restArgs, "--retention-hours", seamConfig.retentionHours ?? 24);
  const queueLimit = numberOption(restArgs, "--queue-limit", seamConfig.queueLimit ?? 1_000);
  seamConfig.rotateMinutes = rotateMinutes;
  seamConfig.retentionHours = retentionHours;
  seamConfig.queueLimit = queueLimit;
} else if (command === "full-raw") {
  seamConfig.fullRawUntil = minutesFromNowIso(minutes);
} else {
  usage();
}

current.capture.seams[seam] = seamConfig;
const next = await state.update(current);
console.log(JSON.stringify({ configPath: RUNTIME_DIAGNOSTICS_CONFIG_PATH, ...next }, null, 2));
