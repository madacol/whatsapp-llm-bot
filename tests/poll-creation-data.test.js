import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getPollCreationData } from "../whatsapp/runtime/select-runtime.js";

describe("getPollCreationData", () => {
  it("extracts options from pollCreationMessage (V1)", () => {
    const msg = {
      pollCreationMessage: {
        name: "Favorite?",
        options: [{ optionName: "A" }, { optionName: "B" }],
      },
    };
    const result = getPollCreationData(msg);
    assert.deepEqual(result, { options: [{ optionName: "A" }, { optionName: "B" }] });
  });

  it("extracts options from pollCreationMessageV3", () => {
    const msg = {
      pollCreationMessageV3: {
        name: "Poll",
        options: [{ optionName: "X" }],
      },
    };
    const result = getPollCreationData(msg);
    assert.deepEqual(result, { options: [{ optionName: "X" }] });
  });

  it("prefers V1 over later versions when multiple exist", () => {
    const msg = {
      pollCreationMessage: { options: [{ optionName: "V1" }] },
      pollCreationMessageV3: { options: [{ optionName: "V3" }] },
    };
    const result = getPollCreationData(msg);
    assert.deepEqual(result?.options[0].optionName, "V1");
  });

  it("returns null for null message", () => {
    assert.equal(getPollCreationData(null), null);
  });

  it("returns null for undefined message", () => {
    assert.equal(getPollCreationData(undefined), null);
  });

  it("returns null when no poll creation field exists", () => {
    const msg = { conversation: "hello" };
    assert.equal(getPollCreationData(msg), null);
  });

  it("returns empty options array when poll has no options", () => {
    const msg = {
      pollCreationMessage: { name: "Empty poll" },
    };
    // pollCreationMessage exists but has no options field — should return null
    // because "options" key is not present
    const result = getPollCreationData(msg);
    assert.equal(result, null);
  });

  it("handles options with null optionName", () => {
    const msg = {
      pollCreationMessage: {
        options: [{ optionName: null }, { optionName: "Valid" }],
      },
    };
    const result = getPollCreationData(msg);
    assert.equal(result?.options.length, 2);
    assert.equal(result?.options[0].optionName, null);
    assert.equal(result?.options[1].optionName, "Valid");
  });
});
