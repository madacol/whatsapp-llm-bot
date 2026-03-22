import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildToolPresentation } from "../tool-presentation-model.js";
import {
  formatToolPresentationDisplay,
  formatToolPresentationInspect,
  formatToolPresentationSummary,
} from "../presentation/whatsapp.js";

describe("tool presentation model", () => {
  it("keeps bash summaries compact while preserving the full command payload", () => {
    const presentation = buildToolPresentation("Bash", {
      command: "apply_patch <<'PATCH'\n*** Begin Patch\n*** End Patch\nPATCH",
    }, undefined, "/repo", undefined);

    assert.equal(presentation.kind, "bash");
    assert.equal(
      formatToolPresentationSummary(presentation),
      "*Bash*  `apply_patch <<'PATCH'`  _+3 lines_",
    );
    assert.ok(presentation.command.includes("*** Begin Patch"));
  });

  it("renders bash initial display from the full command, not the compact summary", () => {
    const presentation = buildToolPresentation("Bash", {
      command: "apply_patch <<'PATCH'\n*** Begin Patch\n*** End Patch\nPATCH",
    }, undefined, "/repo", undefined);

    const display = formatToolPresentationDisplay(presentation);
    assert.ok(Array.isArray(display));
    const block = /** @type {CodeContentBlock} */ (display[0]);
    assert.equal(block.type, "code");
    assert.equal(block.caption, "*Bash*  `apply_patch <<'PATCH'`  _+3 lines_");
    assert.ok(block.code.includes("*** Begin Patch"), block.code);
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
