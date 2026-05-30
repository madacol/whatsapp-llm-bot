import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCommandPresentation, buildToolPresentation } from "../tool-presentation-model.js";
import {
  formatToolPresentationDisplay,
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

  it("keeps command summaries compact while preserving the full command payload", () => {
    const presentation = buildCommandPresentation(
      "apply_patch <<'PATCH'\n*** Begin Patch\n*** End Patch\nPATCH",
    );

    assert.equal(presentation.kind, "bash");
    assert.equal(
      formatToolPresentationSummary(presentation),
      "*Shell*  `apply_patch <<'PATCH'`  _+3 lines_",
    );
    assert.ok(presentation.command.includes("*** Begin Patch"));
  });

  it("renders command initial display from the full command, not the compact summary", () => {
    const presentation = buildCommandPresentation(
      "apply_patch <<'PATCH'\n*** Begin Patch\n*** End Patch\nPATCH",
    );

    const display = formatToolPresentationDisplay(presentation);
    assert.ok(Array.isArray(display));
    const block = /** @type {CodeContentBlock} */ (display[0]);
    assert.equal(block.type, "code");
    assert.equal(block.caption, "*Shell*  `apply_patch <<'PATCH'`  _+3 lines_");
    assert.ok(block.code.includes("*** Begin Patch"), block.code);
  });

  it("builds command events as shell presentations", () => {
    const searchPresentation = buildCommandPresentation("rg -n \"needle\" src");
    const listPresentation = buildCommandPresentation("rg --files src");
    const readPresentation = buildCommandPresentation("sed -n '1,20p' src/app.js");

    assert.equal(formatToolPresentationSummary(searchPresentation), "*Shell*  `rg -n \"needle\" src`");
    assert.equal(formatToolPresentationSummary(listPresentation), "*Shell*  `rg --files src`");
    assert.equal(formatToolPresentationSummary(readPresentation), "*Shell*  `sed -n '1,20p' src/app.js`");
    assert.equal(searchPresentation.kind, "bash");
    assert.equal(searchPresentation.inspectMode, "bash");
    assert.equal(listPresentation.kind, "bash");
    assert.equal(listPresentation.inspectMode, "bash");
    assert.equal(readPresentation.kind, "bash");
    assert.equal(readPresentation.inspectMode, "bash");
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
