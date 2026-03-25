import { getModels as getClaudeSdkModels } from "./claude-agent-sdk.js";
import { getCodexAvailableModels } from "./codex-models.js";

/**
 * Public harness model surface for callers outside the harness subsystem.
 * @param {string} harnessName
 * @returns {Promise<SelectOption[]>}
 */
export async function getHarnessModelOptions(harnessName) {
  if (harnessName === "claude-agent-sdk") {
    return [
      ...getClaudeSdkModels().map((model) => ({ id: model.value, label: model.displayName })),
      { id: "off", label: "Default" },
    ];
  }
  if (harnessName === "codex") {
    const availableModels = await getCodexAvailableModels();
    if (availableModels.length === 0) {
      return [];
    }
    return [
      ...availableModels.map((model) => ({ id: model.id, label: model.label })),
      { id: "off", label: "Default" },
    ];
  }
  return [];
}
