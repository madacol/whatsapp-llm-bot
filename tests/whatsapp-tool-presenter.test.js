import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildToolPresentation } from "../whatsapp/tool-presentation-model.js";
import { formatPlanPresentationText } from "../plan-presentation.js";
import {
  formatCommandInspectText,
  formatToolInspectBody,
  formatSdkToolCall,
  getToolCallSummary,
} from "../whatsapp/tool-presenter.js";

describe("WhatsApp tool presenter", () => {
  it("keeps semantic labels for explicit tools", () => {
    assert.equal(
      formatSdkToolCall("Read", { file_path: "/repo/src/app.js" }, "/repo"),
      "*Read*  `src/app.js`",
    );
    assert.equal(
      formatSdkToolCall("Grep", { pattern: "needle", path: "/repo/src" }, "/repo"),
      "*Search*  \"needle\" in `src`",
    );
    assert.equal(
      formatSdkToolCall("Glob", { pattern: "*.js", path: "/repo/src" }, "/repo"),
      "*List*  `*.js` in `src`",
    );
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
      "*Plan*  _Working on: Patch the formatter_",
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
      "*Plan*  _Next: Check the inspect output_",
    );
  });

  it("keeps ripgrep command output in the bash formatter", () => {
    const text = formatCommandInspectText(
      "rg -n \"needle\" src",
      [
        "src/one.js:3:needle",
        "src/two.js:8:needle again",
      ].join("\n"),
      "bash",
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
      "bash",
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

  it("renders plan presentation bodies as explicit checklists", () => {
    const presentation = buildToolPresentation("update_plan", {
      explanation: "Tighten the display labels",
      plan: [
        { step: "Patch the formatter", status: "in_progress" },
        { step: "Run tests", status: "pending" },
        { step: "Ship the fix", status: "completed" },
      ],
    }, undefined, undefined, undefined);

    assert.equal(
      formatPlanPresentationText(presentation),
      [
        "*Plan*",
        "",
        "_Tighten the display labels_",
        "",
        "- [~] Patch the formatter",
        "- [ ] Run tests",
        "- [x] Ship the fix",
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
