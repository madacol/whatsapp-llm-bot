import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatSdkToolCall,
  formatToolCallDisplay,
  getToolCallSummary,
} from "../tool-display.js";
import { formatCommandInspectText } from "../utils.js";

/** @param {string} name @param {Record<string, unknown>} args */
function toolCall(name, args) {
  return { id: "tool-1", name, arguments: JSON.stringify(args) };
}

describe("tool display", () => {
  it("renders read and search activities by tool type instead of generic explored labels", () => {
    assert.equal(
      formatSdkToolCall("Read", { file_path: "/repo/src/app.js" }, "/repo"),
      "*Read*\n`src/app.js`",
    );
    assert.equal(
      formatSdkToolCall("Grep", { pattern: "needle", path: "/repo/src" }, "/repo"),
      "*Search*\n\"needle\" in `src`",
    );
    assert.equal(
      formatToolCallDisplay(toolCall("Bash", { command: "rg -n \"needle\" src" }), undefined, "/repo"),
      "*Search*\n\"needle\" in `src`",
    );
  });

  it("shows update_plan contents in summaries from plan-style arguments", () => {
    assert.equal(
      formatSdkToolCall("update_plan", {
        explanation: "Tighten the display labels",
        plan: [
          { step: "Patch the formatter", status: "in_progress" },
          { step: "Run tests", status: "pending" },
          { step: "Ship the fix", status: "completed" },
        ],
      }),
      [
        "*Plan*",
        "_Tighten the display labels_",
        "[~] Patch the formatter",
        "[ ] Run tests",
        "[x] Ship the fix",
      ].join("\n"),
    );
  });

  it("shows update_plan contents in summaries from todo-list arguments", () => {
    assert.equal(
      getToolCallSummary("update_plan", {
        items: [
          { text: "Check the inspect output", completed: false },
          { text: "Keep search formatting readable", completed: true },
        ],
      }),
      [
        "*Plan*",
        "[ ] Check the inspect output",
        "[x] Keep search formatting readable",
      ].join("\n"),
    );
  });

  it("uses the command preview in bash captions", () => {
    const result = formatToolCallDisplay(
      toolCall("Bash", { command: "date -u +%FT%TZ" }),
    );
    assert.ok(Array.isArray(result));
    assert.equal(result[0]?.type, "code");
    assert.equal(
      /** @type {CodeContentBlock} */ (result[0]).caption,
      "*Bash*  `date -u +%FT%TZ`",
    );
  });
});

describe("command inspect formatting", () => {
  it("formats ripgrep command output using the search inspector", () => {
    const text = formatCommandInspectText(
      "rg -n \"needle\" src",
      [
        "src/one.js:3:needle",
        "src/two.js:8:needle again",
      ].join("\n"),
      "Bash",
    );
    assert.ok(text.includes("*src/one.js*"), text);
    assert.ok(text.includes("3: needle"), text);
    assert.ok(text.includes("*src/two.js*"), text);
  });

  it("formats read-like shell commands using the read inspector", () => {
    const text = formatCommandInspectText(
      "sed -n '1,20p' src/app.js",
      [
        "1\tconst one = 1;",
        "2\tconst two = 2;",
      ].join("\n"),
      "Bash",
    );
    assert.ok(text.includes("```bash\nsed -n '1,20p' src/app.js\n```"), text);
    assert.ok(text.includes("```\nconst one = 1;\nconst two = 2;\n```"), text);
    assert.ok(!text.includes("1\tconst one = 1;"), text);
  });
});
