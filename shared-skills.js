/**
 * Shared-skill helpers.
 *
 * Shared skills are the small subset of action semantics that should remain
 * visible across non-native harnesses. Native keeps the full executable action
 * surface; other harnesses consume only the shared-skill metadata.
 */

/**
 * @param {Action | ToolDescriptor} action
 * @returns {action is (Action & { sharedSkill: SharedSkill }) | (ToolDescriptor & { sharedSkill: SharedSkill })}
 */
export function hasSharedSkill(action) {
  const skill = action.sharedSkill;
  return !!skill
    && typeof skill.name === "string"
    && !!skill.name.trim()
    && typeof skill.instructions === "string"
    && !!skill.instructions.trim();
}

/**
 * @param {Action[]} actions
 * @param {string} harnessName
 * @returns {Action[]}
 */
export function filterHarnessActions(actions, harnessName) {
  if (harnessName === "native") {
    return actions;
  }
  return actions.filter(hasSharedSkill);
}

/**
 * @param {Array<Action | ToolDescriptor>} actions
 * @returns {Array<(Action & { sharedSkill: SharedSkill }) | (ToolDescriptor & { sharedSkill: SharedSkill })>}
 */
export function getSharedSkillActions(actions) {
  return actions.filter(hasSharedSkill);
}

/**
 * @param {Array<Action | ToolDescriptor>} actions
 * @returns {string}
 */
export function buildSharedSkillPrompt(actions) {
  const sharedSkills = getSharedSkillActions(actions);
  if (sharedSkills.length === 0) {
    return "";
  }

  return [
    "Shared skills available in this chat:",
    ...sharedSkills.map((action) => {
      const description = action.sharedSkill?.description?.trim() || action.description;
      return `- ${action.sharedSkill.name}: ${description}`;
    }),
    "",
    ...sharedSkills.flatMap((action, index) => [
      ...(index === 0 ? [] : [""]),
      `## ${action.sharedSkill.name}`,
      action.sharedSkill.instructions.trim(),
    ]),
  ].join("\n");
}
