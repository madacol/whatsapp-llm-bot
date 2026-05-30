import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildToolPresentation } from "../tool-presentation-model.js";
import {
  formatToolPresentationInspect,
  formatToolPresentationSummary,
} from "../presentation/whatsapp.js";

describe("tool presentation model", () => {
  it("renders file tool starts as direct file actions", () => {
    const editPresentation = buildToolPresentation("Edit", {
      file_path: "/repo/src/app.js",
      old_string: "before",
      new_string: "after",
    }, undefined, "/repo", undefined);
    const writePresentation = buildToolPresentation("Write", {
      file_path: "/repo/src/new.js",
      content: "export const value = 1;\n",
    }, undefined, "/repo", undefined);

    assert.equal(formatToolPresentationSummary(editPresentation), "Editing `src/app.js`");
    assert.equal(formatToolPresentationSummary(writePresentation), "Writing `src/new.js`");
  });

  it("renders full plan details for inspect from the semantic presentation", () => {
    const presentation = buildToolPresentation("update_plan", {
      explanation: "Tighten the display labels",
      plan: [
        { step: "Patch the formatter", status: "in_progress" },
        { step: "Run tests", status: "pending" },
      ],
    }, undefined, null, undefined);

    assert.equal(
      formatToolPresentationInspect(presentation, "Plan updated"),
      [
        "_Tighten the display labels_",
        "[~] Patch the formatter",
        "[ ] Run tests",
        "",
        "Plan updated",
      ].join("\n"),
    );
  });
});
