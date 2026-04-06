import { mkdir, lstat, readlink, symlink } from "node:fs/promises";
import path from "node:path";

export const PROJECT_SKILLS_ROOT = path.join(".agents", "skills");
export const CLAUDE_PROJECT_SKILLS_LINK = path.join(".claude", "skills");
const CLAUDE_PROJECT_SKILLS_TARGET = path.join("..", ".agents", "skills");

/**
 * @param {string} workdir
 * @returns {string}
 */
export function getProjectSkillsRootPath(workdir) {
  return path.join(workdir, PROJECT_SKILLS_ROOT);
}

/**
 * @param {string} workdir
 * @returns {string}
 */
export function getClaudeProjectSkillsLinkPath(workdir) {
  return path.join(workdir, CLAUDE_PROJECT_SKILLS_LINK);
}

/**
 * @param {string} workdir
 * @returns {Promise<void>}
 */
export async function ensureClaudeProjectSkillsLink(workdir) {
  const skillsRootPath = getProjectSkillsRootPath(workdir);
  const linkPath = getClaudeProjectSkillsLinkPath(workdir);

  await mkdir(skillsRootPath, { recursive: true });
  await mkdir(path.dirname(linkPath), { recursive: true });

  try {
    const stats = await lstat(linkPath);
    if (!stats.isSymbolicLink()) {
      throw new Error(`Expected ${linkPath} to be a symlink to ${CLAUDE_PROJECT_SKILLS_TARGET}.`);
    }
    const currentTarget = await readlink(linkPath);
    if (currentTarget !== CLAUDE_PROJECT_SKILLS_TARGET) {
      throw new Error(`Expected ${linkPath} to point to ${CLAUDE_PROJECT_SKILLS_TARGET}, got ${currentTarget}.`);
    }

    return;
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  await symlink(CLAUDE_PROJECT_SKILLS_TARGET, linkPath, "dir");
}

/**
 * @param {unknown} error
 * @returns {error is NodeJS.ErrnoException}
 */
function isMissingFileError(error) {
  return error instanceof Error
    && "code" in error
    && typeof error.code === "string"
    && error.code === "ENOENT";
}
