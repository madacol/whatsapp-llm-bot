import { join } from "node:path";
import { buildSharedSkillMarkdownDocument, getSharedSkillViews } from "../shared-skills.js";

const AGENTS_DIR = ".agents";
const AGENTS_SKILLS_DIR = "skills";
const CLAUDE_SHARED_SKILLS_PLUGIN_NAME = "madabot-shared-skills";

/**
 * @typedef {{
 *   relativePath: string,
 *   content: string,
 * }} ClaudeWorkspaceArtifact
 */

/**
 * @param {ToolRuntime} toolRuntime
 * @returns {ClaudeWorkspaceArtifact[]}
 */
export function buildClaudeWorkspaceArtifacts(toolRuntime) {
  const sharedSkills = getSharedSkillViews(toolRuntime.listTools());
  if (sharedSkills.length === 0) {
    return [];
  }

  return [
    {
      relativePath: `${AGENTS_DIR}/.claude-plugin/plugin.json`,
      content: JSON.stringify({ name: CLAUDE_SHARED_SKILLS_PLUGIN_NAME }, null, 2),
    },
    ...sharedSkills.map((sharedSkill) => ({
      relativePath: `${AGENTS_DIR}/${AGENTS_SKILLS_DIR}/${sharedSkill.name}/SKILL.md`,
      content: buildSharedSkillMarkdownDocument(sharedSkill),
    })),
  ];
}

/**
 * @param {string} workdir
 * @returns {string}
 */
export function getClaudeWorkspaceArtifactsRootPath(workdir) {
  return join(workdir, AGENTS_DIR);
}

/**
 * @param {string} workdir
 * @returns {string}
 */
export function getClaudeWorkspacePluginPath(workdir) {
  return join(workdir, AGENTS_DIR);
}
