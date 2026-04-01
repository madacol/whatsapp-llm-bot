import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const COMMAND_TIMEOUT_MS = 300_000;
const COMMAND_MAX_BUFFER = 2 * 1024 * 1024;

/**
 * @typedef {{
 *   stdout: string;
 *   stderr: string;
 *   exitCode: number;
 * }} CommandResult
 */

/**
 * @param {string} command
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<CommandResult>}
 */
function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: COMMAND_MAX_BUFFER,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout, stderr, exitCode: 0 });
          return;
        }
        if (typeof error.code === "number") {
          resolve({ stdout, stderr, exitCode: error.code });
          return;
        }
        reject(error);
      },
    );
  });
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<CommandResult>}
 */
async function runGit(cwd, args) {
  return runCommand("git", args, cwd);
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<CommandResult>}
 */
async function runPnpm(cwd, args) {
  return runCommand("pnpm", args, cwd);
}

/**
 * @param {CommandResult} result
 * @param {string} fallback
 * @returns {string}
 */
function commandErrorMessage(result, fallback) {
  return result.stderr.trim() || result.stdout.trim() || fallback;
}

/**
 * @param {string} value
 * @returns {string}
 */
function normalizeWhitespace(value) {
  return value.replace(/\r\n/g, "\n").trim();
}

/**
 * @param {string} cwd
 * @returns {Promise<{
 *   rootPath: string,
 *   kind: "repo" | "workspace",
 *   branch: string | null,
 *   commonDir: string,
 * } | null>}
 */
export async function inspectGitWorkspace(cwd) {
  const rootResult = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (rootResult.exitCode !== 0) {
    return null;
  }

  const gitDirResult = await runGit(cwd, ["rev-parse", "--git-dir"]);
  const commonDirResult = await runGit(cwd, ["rev-parse", "--git-common-dir"]);
  const branchResult = await runGit(cwd, ["branch", "--show-current"]);
  if (gitDirResult.exitCode !== 0 || commonDirResult.exitCode !== 0) {
    return null;
  }

  const rootPath = normalizeWhitespace(rootResult.stdout);
  const resolvedCwd = path.resolve(cwd);
  if (path.resolve(rootPath) !== resolvedCwd) {
    return null;
  }

  const gitDir = path.resolve(cwd, normalizeWhitespace(gitDirResult.stdout));
  const commonDir = path.resolve(cwd, normalizeWhitespace(commonDirResult.stdout));
  const branchText = branchResult.exitCode === 0 ? normalizeWhitespace(branchResult.stdout) : "";
  return {
    rootPath,
    kind: gitDir === commonDir ? "repo" : "workspace",
    branch: branchText || null,
    commonDir,
  };
}

/**
 * @param {string} workspaceName
 * @returns {boolean}
 */
export function isValidWorkspaceName(workspaceName) {
  return /^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(workspaceName.trim());
}

/**
 * @param {string} workspaceName
 * @returns {string}
 */
export function getWorkspaceBranchName(workspaceName) {
  const slug = workspaceName
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) {
    throw new Error("Workspace name must contain at least one letter or number.");
  }
  return slug;
}

/**
 * @param {RepoRow} repo
 * @param {string} workspaceKey
 * @returns {string}
 */
export function getWorkspacePath(repo, workspaceKey) {
  return path.resolve(repo.root_path, "..", ".madabot-worktrees", repo.name, workspaceKey);
}

/**
 * @param {string} targetPath
 * @returns {Promise<boolean>}
 */
async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/**
 * @param {RepoRow} repo
 * @param {string} workspaceName
 * @returns {Promise<{ branch: string, worktreePath: string }>}
 */
async function resolveWorkspaceRef(repo, workspaceName) {
  const baseKey = getWorkspaceBranchName(workspaceName);
  let suffix = 1;

  while (true) {
    const candidateKey = suffix === 1 ? baseKey : `${baseKey}-${suffix}`;
    const candidatePath = getWorkspacePath(repo, candidateKey);
    if (!await branchExists(repo.root_path, candidateKey) && !await pathExists(candidatePath)) {
      return {
        branch: candidateKey,
        worktreePath: candidatePath,
      };
    }
    suffix += 1;
  }
}

/**
 * @param {string} repoRoot
 * @param {string} branchName
 * @returns {Promise<boolean>}
 */
async function branchExists(repoRoot, branchName) {
  const result = await runGit(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`]);
  return result.exitCode === 0;
}

/**
 * @param {string} repoRoot
 * @param {string} branchName
 * @returns {Promise<boolean>}
 */
async function ensureBranchExists(repoRoot, branchName) {
  const result = await runGit(repoRoot, ["rev-parse", "--verify", branchName]);
  return result.exitCode === 0;
}

/**
 * @param {string} repoRoot
 * @param {string} branchName
 * @returns {Promise<void>}
 */
async function deleteBranchIfExists(repoRoot, branchName) {
  if (await branchExists(repoRoot, branchName)) {
    await runGit(repoRoot, ["branch", "-D", branchName]);
  }
}

/**
 * @param {string} worktreePath
 * @returns {Promise<void>}
 */
async function removeDirectoryIfExists(worktreePath) {
  await fs.rm(worktreePath, { recursive: true, force: true });
}

/**
 * @param {string} repoRoot
 * @param {string} worktreePath
 * @returns {Promise<void>}
 */
async function removeWorktreeIfExists(repoRoot, worktreePath) {
  await runGit(repoRoot, ["worktree", "remove", "--force", worktreePath]);
  await removeDirectoryIfExists(worktreePath);
}

/**
 * @param {string} cwd
 * @returns {Promise<string[]>}
 */
export async function listConflictedFiles(cwd) {
  const result = await runGit(cwd, ["diff", "--name-only", "--diff-filter=U"]);
  if (result.exitCode !== 0) {
    return [];
  }
  return normalizeWhitespace(result.stdout)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * @param {string} cwd
 * @returns {Promise<boolean>}
 */
export async function hasUncommittedChanges(cwd) {
  const result = await runGit(cwd, ["status", "--porcelain"]);
  if (result.exitCode !== 0) {
    throw new Error(commandErrorMessage(result, `git status failed in ${cwd}`));
  }
  return normalizeWhitespace(result.stdout) !== "";
}

/**
 * @param {string} cwd
 * @returns {Promise<string | null>}
 */
export async function getHeadShortOid(cwd) {
  const result = await runGit(cwd, ["rev-parse", "--short", "HEAD"]);
  if (result.exitCode !== 0) {
    return null;
  }
  const trimmed = normalizeWhitespace(result.stdout);
  return trimmed || null;
}

/**
 * @param {string} cwd
 * @returns {Promise<string[]>}
 */
export async function listChangedFiles(cwd) {
  const result = await runGit(cwd, ["status", "--short"]);
  if (result.exitCode !== 0) {
    throw new Error(commandErrorMessage(result, `git status failed in ${cwd}`));
  }
  return normalizeWhitespace(result.stdout)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

/**
 * @param {string} cwd
 * @returns {Promise<string>}
 */
export async function formatDiffSummary(cwd) {
  const files = await listChangedFiles(cwd);
  if (files.length === 0) {
    return "No uncommitted changes.";
  }
  const statResult = await runGit(cwd, ["diff", "--stat"]);
  const statText = statResult.exitCode === 0 ? normalizeWhitespace(statResult.stdout) : "";
  return [
    "Changed files:",
    ...files.map((file) => `- \`${file}\``),
    ...(statText ? ["", "Summary:", statText] : []),
  ].join("\n");
}

/**
 * @param {string} cwd
 * @param {string} message
 * @returns {Promise<string>}
 */
export async function commitWorkspaceChanges(cwd, message) {
  const addResult = await runGit(cwd, ["add", "-A"]);
  if (addResult.exitCode !== 0) {
    throw new Error(commandErrorMessage(addResult, "git add failed."));
  }
  const commitResult = await runGit(cwd, ["commit", "-m", message]);
  if (commitResult.exitCode !== 0) {
    throw new Error(commandErrorMessage(commitResult, "git commit failed."));
  }
  const oid = await getHeadShortOid(cwd);
  if (!oid) {
    throw new Error("Commit completed but HEAD oid could not be determined.");
  }
  return oid;
}

/**
 * @param {string} repoRoot
 * @param {string} baseBranch
 * @returns {Promise<void>}
 */
async function maybeUpdateBaseBranch(repoRoot, baseBranch) {
  const upstreamResult = await runGit(repoRoot, ["rev-parse", "--abbrev-ref", `${baseBranch}@{upstream}`]);
  const checkoutResult = await runGit(repoRoot, ["checkout", baseBranch]);
  if (checkoutResult.exitCode !== 0) {
    throw new Error(commandErrorMessage(checkoutResult, `Could not check out ${baseBranch}.`));
  }
  if (upstreamResult.exitCode !== 0) {
    return;
  }
  const pullResult = await runGit(repoRoot, ["pull", "--ff-only"]);
  if (pullResult.exitCode !== 0) {
    throw new Error(commandErrorMessage(pullResult, `Could not update ${baseBranch}.`));
  }
}

/**
 * @param {string} repoRoot
 * @returns {Promise<void>}
 */
async function ensureMainRepoClean(repoRoot) {
  if (await hasUncommittedChanges(repoRoot)) {
    throw new Error("The main repo has uncommitted changes. Merge from a clean base checkout.");
  }
}

/**
 * @param {string} cwd
 * @returns {Promise<{ passed: boolean, summary: string }>}
 */
export async function runWorkspaceVerification(cwd) {
  const packageJsonPath = path.join(cwd, "package.json");
  let packageJsonText;
  try {
    packageJsonText = await fs.readFile(packageJsonPath, "utf8");
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") {
      return { passed: true, summary: "No verification scripts configured." };
    }
    throw error;
  }

  const parsed = JSON.parse(packageJsonText);
  const scripts = parsed && typeof parsed === "object" && parsed.scripts && typeof parsed.scripts === "object"
    ? parsed.scripts
    : {};
  /** @type {string[]} */
  const lines = [];

  if (typeof scripts["type-check"] === "string") {
    const result = await runPnpm(cwd, ["type-check"]);
    if (result.exitCode !== 0) {
      return { passed: false, summary: `Type-check failed.\n${commandErrorMessage(result, "pnpm type-check failed.")}` };
    }
    lines.push("Type-check passed.");
  }

  if (typeof scripts.test === "string") {
    const result = await runPnpm(cwd, ["test"]);
    if (result.exitCode !== 0) {
      return { passed: false, summary: `Tests failed.\n${commandErrorMessage(result, "pnpm test failed.")}` };
    }
    lines.push("Tests passed.");
  }

  if (lines.length === 0) {
    return { passed: true, summary: "No verification scripts configured." };
  }

  return { passed: true, summary: lines.join("\n") };
}

/**
 * @param {RepoRow} repo
 * @param {string} workspaceName
 * @param {string} baseBranch
 * @returns {Promise<{ branch: string, worktreePath: string }>}
 */
export async function createWorkspaceWorktree(repo, workspaceName, baseBranch) {
  if (!isValidWorkspaceName(workspaceName)) {
    throw new Error("Workspace name is invalid. Use letters, numbers, spaces, `-`, and `_`.");
  }
  if (!await ensureBranchExists(repo.root_path, baseBranch)) {
    throw new Error(`Base branch \`${baseBranch}\` does not exist.`);
  }

  const { branch, worktreePath } = await resolveWorkspaceRef(repo, workspaceName);
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });

  const addResult = await runGit(repo.root_path, ["worktree", "add", "-b", branch, worktreePath, baseBranch]);
  if (addResult.exitCode !== 0) {
    throw new Error(commandErrorMessage(addResult, "git worktree add failed."));
  }

  return { branch, worktreePath };
}

/**
 * @param {RepoRow} repo
 * @param {string} branch
 * @param {string} worktreePath
 * @returns {Promise<void>}
 */
export async function cleanupWorkspaceWorktree(repo, branch, worktreePath) {
  await removeWorktreeIfExists(repo.root_path, worktreePath);
  await deleteBranchIfExists(repo.root_path, branch);
}

/**
 * @param {string} repoRoot
 * @param {WorkspaceRow} workspace
 * @returns {Promise<
 *   | { kind: "merged", summary: string, lastCommitOid: string | null }
 *   | { kind: "conflicted", files: string[] }
 *   | { kind: "blocked", summary: string, lastCommitOid: string | null }
 * >}
 */
export async function mergeWorkspaceBranch(repoRoot, workspace) {
  if (await hasUncommittedChanges(workspace.worktree_path)) {
    throw new Error("Cannot merge with uncommitted changes.\nUse `!commit <message>` first.");
  }

  const verification = await runWorkspaceVerification(workspace.worktree_path);
  if (!verification.passed) {
    return { kind: "blocked", summary: verification.summary, lastCommitOid: await getHeadShortOid(workspace.worktree_path) };
  }

  await ensureMainRepoClean(repoRoot);
  await maybeUpdateBaseBranch(repoRoot, workspace.base_branch);

  const syncResult = await runGit(workspace.worktree_path, ["merge", "--no-edit", workspace.base_branch]);
  if (syncResult.exitCode !== 0) {
    const conflictedFiles = await listConflictedFiles(workspace.worktree_path);
    if (conflictedFiles.length > 0) {
      return { kind: "conflicted", files: conflictedFiles };
    }
    throw new Error(commandErrorMessage(syncResult, `Could not merge ${workspace.base_branch} into ${workspace.branch}.`));
  }

  const landResult = await runGit(repoRoot, ["merge", "--no-edit", workspace.branch]);
  if (landResult.exitCode !== 0) {
    await runGit(repoRoot, ["merge", "--abort"]);
    throw new Error(commandErrorMessage(landResult, `Could not merge ${workspace.branch} into ${workspace.base_branch}.`));
  }

  const lastCommitOid = await getHeadShortOid(workspace.worktree_path);
  return {
    kind: "merged",
    summary: `${verification.summary}\nMerge completed.`,
    lastCommitOid,
  };
}

/**
 * @param {string} fileText
 * @returns {string | null}
 */
function resolveConflictMarkersKeepingOurs(fileText) {
  if (!fileText.includes("<<<<<<<")) {
    return fileText;
  }

  const lines = fileText.split("\n");
  /** @type {string[]} */
  const output = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.startsWith("<<<<<<<")) {
      output.push(line);
      index += 1;
      continue;
    }

    index += 1;
    /** @type {string[]} */
    const ours = [];
    while (index < lines.length && !lines[index].startsWith("=======")) {
      ours.push(lines[index]);
      index += 1;
    }
    if (index >= lines.length) {
      return null;
    }

    index += 1;
    while (index < lines.length && !lines[index].startsWith(">>>>>>>")) {
      index += 1;
    }
    if (index >= lines.length) {
      return null;
    }

    output.push(...ours);
    index += 1;
  }

  return output.join("\n");
}

/**
 * @param {WorkspaceRow} workspace
 * @returns {Promise<{ resolved: boolean, summary: string, lastCommitOid: string | null }>}
 */
export async function resolveWorkspaceConflictsAutomatically(workspace) {
  const conflictedFiles = await listConflictedFiles(workspace.worktree_path);
  if (conflictedFiles.length === 0) {
    return { resolved: true, summary: "No conflicted files remain.", lastCommitOid: await getHeadShortOid(workspace.worktree_path) };
  }

  for (const file of conflictedFiles) {
    const absolutePath = path.join(workspace.worktree_path, file);
    const currentText = await fs.readFile(absolutePath, "utf8");
    const resolved = resolveConflictMarkersKeepingOurs(currentText);
    if (resolved === null) {
      return { resolved: false, summary: `I could not safely resolve all conflicts.\nRemaining conflicted files:\n- \`${file}\``, lastCommitOid: await getHeadShortOid(workspace.worktree_path) };
    }
    await fs.writeFile(absolutePath, resolved);
  }

  const addResult = await runGit(workspace.worktree_path, ["add", ...conflictedFiles]);
  if (addResult.exitCode !== 0) {
    throw new Error(commandErrorMessage(addResult, "git add failed while resolving conflicts."));
  }
  const commitResult = await runGit(workspace.worktree_path, ["commit", "-m", `Resolve merge conflicts for ${workspace.branch}`]);
  if (commitResult.exitCode !== 0) {
    throw new Error(commandErrorMessage(commitResult, "git commit failed while resolving conflicts."));
  }

  const verification = await runWorkspaceVerification(workspace.worktree_path);
  const lastCommitOid = await getHeadShortOid(workspace.worktree_path);
  if (!verification.passed) {
    return { resolved: true, summary: `Resolved conflicts in \`${workspace.branch}\`.\n${verification.summary}`, lastCommitOid };
  }

  return {
    resolved: true,
    summary: `Resolved conflicts in \`${workspace.branch}\`.\n${verification.summary}\n\nRun \`!merge\` to retry landing this workspace.`,
    lastCommitOid,
  };
}

/**
 * @param {WorkspaceRow} workspace
 * @returns {Promise<void>}
 */
export async function abortWorkspaceMerge(workspace) {
  const result = await runGit(workspace.worktree_path, ["merge", "--abort"]);
  if (result.exitCode !== 0) {
    throw new Error(commandErrorMessage(result, "git merge --abort failed."));
  }
}
