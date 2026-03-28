import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatToolInspectBody,
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
  it("keeps semantic labels for explicit tools but not for shell commands", () => {
    assert.equal(
      formatSdkToolCall("Read", { file_path: "/repo/src/app.js" }, "/repo"),
      "*Read*  `src/app.js`",
    );
    assert.equal(
      formatSdkToolCall("Grep", { pattern: "needle", path: "/repo/src" }, "/repo"),
      "*Search*  \"needle\" in `src`",
    );
    const bashResult = formatToolCallDisplay(toolCall("Bash", { command: "rg -n \"needle\" src" }), undefined, "/repo");
    assert.ok(Array.isArray(bashResult));
    assert.equal(bashResult[0]?.type, "code");
    assert.equal(/** @type {CodeContentBlock} */ (bashResult[0]).caption, "*Bash*  `rg -n \"needle\" src`");
  });

  it("keeps rg --files shell commands as Bash", () => {
    const bashResult = formatToolCallDisplay(toolCall("Bash", { command: "rg --files src" }), undefined, "/repo");
    assert.ok(Array.isArray(bashResult));
    assert.equal(bashResult[0]?.type, "code");
    assert.equal(/** @type {CodeContentBlock} */ (bashResult[0]).caption, "*Bash*  `rg --files src`");

    assert.equal(
      formatSdkToolCall("Glob", { pattern: "*.js", path: "/repo/src" }, "/repo"),
      "*List*  `*.js` in `src`",
    );
  });

  it("keeps piped ripgrep shell commands as Bash", () => {
    const bashResult = formatToolCallDisplay(
      toolCall("Bash", { command: "rg --files . | rg \"needle\"" }),
      undefined,
      "/repo",
    );
    assert.ok(Array.isArray(bashResult));
    assert.equal(bashResult[0]?.type, "code");
    assert.equal(/** @type {CodeContentBlock} */ (bashResult[0]).caption, "*Bash*  `rg --files . | rg \"needle\"`");
  });

  it("keeps non-rg shell inspection commands as Bash", () => {
    const bashResult = formatToolCallDisplay(
      toolCall("Bash", { command: "sed -n '1,20p' src/app.js" }),
      undefined,
      "/repo",
    );
    assert.ok(Array.isArray(bashResult));
    assert.equal(bashResult[0]?.type, "code");
    assert.equal(/** @type {CodeContentBlock} */ (bashResult[0]).caption, "*Bash*  `sed -n '1,20p' src/app.js`");
  });

  it("renders web sub-actions with intent-specific labels", () => {
    assert.equal(
      getToolCallSummary("search_query", {
        search_query: [{ q: "UTC+00:00" }],
      }),
      "*Search Web*  \"UTC+00:00\"",
    );
    assert.equal(
      getToolCallSummary("open", {
        ref_id: "https://en.wikipedia.org/wiki/UTC%2B00%3A00",
      }),
      "*Open Link*  `en.wikipedia.org/wiki/UTC%2B00%3A00`",
    );
    assert.equal(
      getToolCallSummary("find", {
        ref_id: "https://en.wikipedia.org/wiki/UTC%2B00%3A00",
        pattern: "UTC+00:00 is an identifier for a time offset from UTC of +00:00.",
      }),
      "*Find On Page*  \"UTC+00:00 is an identifier for a time offset from UTC of +00:00.\" in `en.wikipedia.org/wiki/UTC%2B00%3A00`",
    );
  });

  it("renders other structured lookup tools with intent-specific labels", () => {
    assert.equal(
      getToolCallSummary("time", {
        time: [{ utc_offset: "+00:00" }],
      }),
      "*Time*  `UTC+00:00`",
    );
    assert.equal(
      getToolCallSummary("weather", {
        weather: [{ location: "San Francisco, CA" }],
      }),
      "*Weather*  `San Francisco, CA`",
    );
    assert.equal(
      getToolCallSummary("finance", {
        finance: [{ ticker: "AMD", type: "equity", market: "USA" }],
      }),
      "*Quote*  `AMD`",
    );
    assert.equal(
      getToolCallSummary("spawn_agent", {
        prompt: "Investigate the failing API route",
      }),
      "*Start Agent*  _Investigate the failing API route_",
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
      "*Plan*  _3 steps_",
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
      "*Plan*  _2 steps_",
    );
  });

  it("keeps bash tool calls compact in the immediate display", () => {
    const result = formatToolCallDisplay(
      toolCall("Bash", { command: "date -u +%FT%TZ" }),
    );
    assert.ok(Array.isArray(result));
    assert.equal(result[0]?.type, "code");
    assert.equal(/** @type {CodeContentBlock} */ (result[0]).caption, "*Bash*  `date -u +%FT%TZ`");
    assert.equal(/** @type {CodeContentBlock} */ (result[0]).code, "date -u +%FT%TZ");
  });

  it("keeps multiline bash summaries short while rendering the full command image", () => {
    const args = {
        command: "apply_patch <<'PATCH'\n*** Begin Patch\n*** End Patch\nPATCH",
      };
    assert.equal(
      getToolCallSummary("Bash", args),
      "*Bash*  `apply_patch <<'PATCH'`  _+3 lines_",
    );
    const result = formatToolCallDisplay(toolCall("Bash", args));
    assert.ok(Array.isArray(result));
    assert.equal(result[0]?.type, "code");
    const block = /** @type {CodeContentBlock} */ (result[0]);
    assert.equal(block.caption, "*Bash*  `apply_patch <<'PATCH'`  _+3 lines_");
    assert.ok(block.code.includes("*** Begin Patch"), block.code);
    assert.ok(block.code.includes("*** End Patch"), block.code);
  });
});

describe("command inspect formatting", () => {
  it("keeps ripgrep command output in the bash formatter", () => {
    const text = formatCommandInspectText(
      "rg -n \"needle\" src",
      [
        "src/one.js:3:needle",
        "src/two.js:8:needle again",
      ].join("\n"),
      "Bash",
    );
    assert.ok(text.includes("```bash\nrg -n \"needle\" src\n```"), text);
    assert.ok(text.includes("src/one.js:3:needle"), text);
    assert.ok(text.includes("src/two.js:8:needle again"), text);
  });

  it("keeps non-rg shell inspect output in the bash formatter", () => {
    const text = formatCommandInspectText(
      "sed -n '1,20p' src/app.js",
      [
        "1\tconst one = 1;",
        "2\tconst two = 2;",
      ].join("\n"),
      "Bash",
    );
    assert.ok(text.includes("```bash\nsed -n '1,20p' src/app.js\n```"), text);
    assert.ok(text.includes("1\tconst one = 1;"), text);
    assert.ok(text.includes("2\tconst two = 2;"), text);
  });

  it("keeps full plan details for inspect while summaries stay short", () => {
    assert.equal(
      formatToolInspectBody("update_plan", {
        explanation: "Tighten the display labels",
        plan: [
          { step: "Patch the formatter", status: "in_progress" },
          { step: "Run tests", status: "pending" },
        ],
      }, "Plan updated"),
      [
        "_Tighten the display labels_",
        "[~] Patch the formatter",
        "[ ] Run tests",
        "",
        "Plan updated",
      ].join("\n"),
    );
  });

  it("formats finance inspect output as readable market data", () => {
    assert.equal(
      formatToolInspectBody("finance", {
        finance: [{ ticker: "AMD", type: "equity", market: "USA" }],
      }, JSON.stringify([
        {
          ticker: "AMD",
          price: 227.45,
          currency: "USD",
          market: "USA",
          change: 3.14,
          change_percent: 1.4,
        },
      ])),
      [
        "*AMD*",
        "Price: 227.45 USD",
        "Change: +3.14 (+1.4%)",
        "Market: USA",
      ].join("\n"),
    );
  });

  it("formats weather inspect output as readable conditions", () => {
    assert.equal(
      formatToolInspectBody("weather", {
        weather: [{ location: "San Francisco, CA" }],
      }, JSON.stringify([
        {
          location: "San Francisco, CA",
          temperature: 17,
          temperature_unit: "C",
          condition: "Sunny",
          high: 19,
          low: 12,
        },
      ])),
      [
        "*San Francisco, CA*",
        "Condition: Sunny",
        "Temperature: 17 C",
        "Range: 12-19 C",
      ].join("\n"),
    );
  });
});
