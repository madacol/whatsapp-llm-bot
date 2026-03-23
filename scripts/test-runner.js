import { readdirSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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
 * @returns {{ watch: boolean, cliArgs: string[] }}
 */
function parseRunnerArgs(argv) {
  if (argv[0] === "--watch") {
    return {
      watch: true,
      cliArgs: argv.slice(1),
    };
  }
  return {
    watch: false,
    cliArgs: argv,
  };
}

/**
 * @returns {Promise<void>}
 */
async function main() {
  const { watch, cliArgs } = parseRunnerArgs(process.argv.slice(2));
  const child = spawn(process.execPath, buildNodeTestArgs(cliArgs, {
    defaultTestFiles: listDefaultTestFiles(),
    watch,
  }), {
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
