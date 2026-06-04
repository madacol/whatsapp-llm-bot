import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { __testAcpModelCommand } from "../harnesses/acp.js";

describe("ACP /model command option derivation", () => {
  it("derives model and effort choices from ACP session model state", () => {
    const modelState = {
      currentModelId: "gpt-5.5[medium]",
      availableModels: [
        { modelId: "gpt-5.5[low]", name: "GPT-5.5 (low)", description: "Lower latency" },
        { modelId: "gpt-5.5[medium]", name: "GPT-5.5 (medium)", description: "Balanced" },
        { modelId: "gpt-5.5[high]", name: "GPT-5.5 (high)", description: "Deeper reasoning" },
        { modelId: "gpt-5.4[medium]", name: "GPT-5.4 (medium)", description: "Previous model" },
      ],
    };

    assert.deepEqual(__testAcpModelCommand.modelStateModelOptions(modelState), [
      { id: "gpt-5.5", label: "GPT-5.5", description: "Lower latency" },
      { id: "gpt-5.4", label: "GPT-5.4", description: "Previous model" },
    ]);
    assert.deepEqual(__testAcpModelCommand.modelStateEffortOptions(modelState, "gpt-5.5"), [
      { id: "low", label: "low", description: "Lower latency" },
      { id: "medium", label: "medium", description: "Balanced" },
      { id: "high", label: "high", description: "Deeper reasoning" },
    ]);
  });

  it("detects fast mode only when the provider exposes a matching config option", () => {
    assert.equal(__testAcpModelCommand.findFastModeConfigOption([]), null);

    const optionByCategory = {
      type: "boolean",
      id: "speed",
      name: "Speed",
      category: "fast_mode",
    };
    const optionByName = {
      type: "boolean",
      id: "quick-toggle",
      name: "Fast Mode",
    };

    assert.equal(__testAcpModelCommand.findFastModeConfigOption([optionByCategory]), optionByCategory);
    assert.equal(__testAcpModelCommand.findFastModeConfigOption([optionByName]), optionByName);
  });

  it("parses ACP model ids with optional effort suffixes", () => {
    assert.deepEqual(__testAcpModelCommand.parseAcpModelId("gpt-5.5[high]"), {
      model: "gpt-5.5",
      effort: "high",
    });
    assert.deepEqual(__testAcpModelCommand.parseAcpModelId("gpt-5.5"), {
      model: "gpt-5.5",
      effort: null,
    });
  });
});
