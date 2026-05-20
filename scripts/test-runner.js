import { readdirSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const RENDERING_HEAVY_TEST_FILES = new Set([
  "tests/code-image-renderer.test.js",
]);

/**
 * @param {string} arg
 * @returns {boolean}
 */
export function isExplicitTestTarget(arg) {
  if (arg.startsWith("-")) {
    return false;
  }
  if (arg.includes("*")) {
    return true;
  }
  if (existsSync(arg)) {
    return true;
  }
  return arg.endsWith(".js");
}

/**
 * @param {string} [testDir]
 * @returns {string[]}
 */
export function listDefaultTestFiles(testDir = "tests") {
  return readdirSync(testDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.js"))
    .map((entry) => join(testDir, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

/**
 * @param {string[]} files
 * @param {"all" | "fast" | "rendering"} mode
 * @returns {string[]}
 */
export function filterDefaultTestFiles(files, mode) {
  if (mode === "all") {
    return files;
  }
  return files.filter((file) => mode === "rendering"
    ? RENDERING_HEAVY_TEST_FILES.has(file)
    : !RENDERING_HEAVY_TEST_FILES.has(file));
}

/**
 * @param {string[]} cliArgs
 * @param {{ defaultTestFiles: string[], watch?: boolean }} options
 * @returns {string[]}
 */
export function buildNodeTestArgs(cliArgs, options) {
  const hasExplicitTargets = cliArgs.some(isExplicitTestTarget);
  return [
    "--test",
    "--experimental-test-isolation=none",
    ...(options.watch ? ["--watch"] : []),
    ...cliArgs,
    ...(hasExplicitTargets ? [] : options.defaultTestFiles),
  ];
}

/**
 * @param {string[]} argv
 * @returns {{ watch: boolean, mode: "all" | "fast" | "rendering", cliArgs: string[] }}
 */
function parseRunnerArgs(argv) {
  let watch = false;
  /** @type {"all" | "fast" | "rendering"} */
  let mode = "all";
  /** @type {string[]} */
  const cliArgs = [];

  for (const arg of argv) {
    if (arg === "--watch") {
      watch = true;
      continue;
    }
    if (arg === "--fast") {
      mode = "fast";
      continue;
    }
    if (arg === "--rendering") {
      mode = "rendering";
      continue;
    }
    cliArgs.push(arg);
  }

  return {
    watch,
    mode,
    cliArgs,
  };
}

/**
 * @returns {Promise<void>}
 */
async function main() {
  const { watch, mode, cliArgs } = parseRunnerArgs(process.argv.slice(2));
  const child = spawn(process.execPath, buildNodeTestArgs(cliArgs, {
    defaultTestFiles: filterDefaultTestFiles(listDefaultTestFiles(), mode),
    watch,
  }), {
    env: { ...process.env, TESTING: process.env.TESTING ?? "1" },
    stdio: "inherit",
  });

  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        resolve(1);
        return;
      }
      resolve(code ?? 0);
    });
  });

  process.exit(exitCode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
