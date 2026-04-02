/**
 * Shared-skill helpers.
 *
 * Shared skills are the small subset of action semantics that should remain
 * visible across non-native harnesses. Native keeps the full executable action
 * surface; other harnesses consume only the shared-skill metadata.
 */

/**
 * @typedef {{
 *   actionName: string,
 *   name: string,
 *   description: string,
 *   instructions: string,
 * }} SharedSkillView
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
 * @returns {SharedSkillView[]}
 */
export function getSharedSkillViews(actions) {
  return getSharedSkillActions(actions).map((action) => ({
    actionName: action.name,
    name: action.sharedSkill.name.trim(),
    description: action.sharedSkill.description?.trim() || action.description,
    instructions: action.sharedSkill.instructions.trim(),
  }));
}

/**
 * @returns {string}
 */
export function getSharedSkillInvocationInstructions() {
  return "To invoke a shared skill, respond with exactly one fenced `madabot-skill` JSON block and no extra text.";
}

/**
 * @param {SharedSkillView} sharedSkill
 * @returns {string}
 */
export function buildSharedSkillMarkdownDocument(sharedSkill) {
  return [
    "---",
    `name: ${sharedSkill.name}`,
    `description: ${sharedSkill.description}`,
    "---",
    "",
    `# ${sharedSkill.name}`,
    "",
    sharedSkill.instructions,
  ].join("\n");
}

/**
 * @param {Array<Action | ToolDescriptor>} actions
 * @returns {string}
 */
export function buildSharedSkillPrompt(actions) {
  const sharedSkills = getSharedSkillViews(actions);
  if (sharedSkills.length === 0) {
    return "";
  }

  return [
    "Shared skills available in this chat:",
    getSharedSkillInvocationInstructions(),
    ...sharedSkills.map((sharedSkill) => `- ${sharedSkill.name}: ${sharedSkill.description}`),
    "",
    ...sharedSkills.flatMap((sharedSkill, index) => [
      ...(index === 0 ? [] : [""]),
      `## ${sharedSkill.name}`,
      sharedSkill.instructions,
    ]),
  ].join("\n");
}
