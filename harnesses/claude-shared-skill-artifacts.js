import { join } from "node:path";
import { buildSharedSkillMarkdownDocument, getSharedSkillViews } from "../shared-skills.js";

const MADABOT_WORKSPACE_DIR = ".madabot";
const CLAUDE_SHARED_SKILLS_PLUGIN_DIR = "claude-shared-skills";
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
      relativePath: `${MADABOT_WORKSPACE_DIR}/${CLAUDE_SHARED_SKILLS_PLUGIN_DIR}/.claude-plugin/plugin.json`,
      content: JSON.stringify({ name: CLAUDE_SHARED_SKILLS_PLUGIN_NAME }, null, 2),
    },
    ...sharedSkills.map((sharedSkill) => ({
      relativePath: `${MADABOT_WORKSPACE_DIR}/${CLAUDE_SHARED_SKILLS_PLUGIN_DIR}/skills/${sharedSkill.name}/SKILL.md`,
      content: buildSharedSkillMarkdownDocument(sharedSkill),
    })),
  ];
}

/**
 * @param {string} workdir
 * @returns {string}
 */
export function getClaudeWorkspaceArtifactsRootPath(workdir) {
  return join(workdir, MADABOT_WORKSPACE_DIR);
}

/**
 * @param {string} workdir
 * @returns {string}
 */
export function getClaudeWorkspacePluginPath(workdir) {
  return join(workdir, MADABOT_WORKSPACE_DIR, CLAUDE_SHARED_SKILLS_PLUGIN_DIR);
}
