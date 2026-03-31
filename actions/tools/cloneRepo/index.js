import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { errorToString, getChatWorkDir } from "../../../utils.js";

const CLONE_TIMEOUT_MS = 300_000;
const CLONE_MAX_BUFFER = 1024 * 1024;

/**
 * @param {string} repository
 * @param {string} cwd
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number }>}
 */
function runGitClone(repository, cwd) {
  return new Promise((resolveResult, reject) => {
    execFile(
      "git",
      ["clone", "--", repository],
      { cwd, timeout: CLONE_TIMEOUT_MS, maxBuffer: CLONE_MAX_BUFFER },
      (error, stdout, stderr) => {
        if (!error) {
          resolveResult({ stdout, stderr, exitCode: 0 });
          return;
        }
        if (typeof error.code === "number") {
          resolveResult({ stdout, stderr, exitCode: error.code });
          return;
        }
        reject(error);
      },
    );
  });
}

/**
 * @param {string} stderr
 * @param {string} cwd
 * @returns {string | null}
 */
function extractClonedPath(stderr, cwd) {
  const match = stderr.match(/Cloning into '([^']+)'/);
  if (!match?.[1]) {
    return null;
  }
  return resolve(cwd, match[1]);
}

export default /** @type {defineAction} */ ((x) => x)({
  name: "clone_repository",
  command: "clone",
  description: "Clone a git repository into the current harness working folder.",
  parameters: {
    type: "object",
    properties: {
      repository: {
        type: "string",
        description: "Git repository URL or local path to clone into the current working folder.",
      },
    },
    required: ["repository"],
  },
  permissions: {
    requireAdmin: true,
    autoExecute: true,
    autoContinue: true,
    useRootDb: true,
  },
  /**
   * @param {{ repository?: string }} params
   * @returns {string}
   */
  formatToolCall: ({ repository }) => repository ? `Cloning ${repository}` : "Cloning repository",
  /**
   * @param {ExtendedActionContext<{ requireAdmin: true, autoExecute: true, autoContinue: true, useRootDb: true }>} context
   * @param {{ repository?: string }} params
   * @returns {Promise<string>}
   */
  action_fn: async function ({ chatId, rootDb }, { repository }) {
    const trimmedRepository = repository?.trim();
    if (!trimmedRepository) {
      return "Usage: !clone <repository_url>";
    }

    const { rows } = await rootDb.sql`
      SELECT harness_cwd
      FROM chats
      WHERE chat_id = ${chatId}
      LIMIT 1
    `;
    const configuredCwd = typeof rows[0]?.harness_cwd === "string" ? rows[0].harness_cwd : null;
    const workdir = getChatWorkDir(chatId, configuredCwd);

    try {
      const result = await runGitClone(trimmedRepository, workdir);
      if (result.exitCode !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim() || `git clone exited with code ${result.exitCode}.`;
        return `Error: git clone failed in \`${workdir}\`.\n${detail}`;
      }

      const clonedPath = extractClonedPath(result.stderr, workdir) ?? workdir;
      return `Cloned into \`${clonedPath}\`.`;
    } catch (error) {
      return `Error: ${errorToString(error)}`;
    }
  },
});
