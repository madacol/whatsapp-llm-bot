import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractCodexStatusPanel, formatCodexStatusForReply } from "../harnesses/codex-cli-status.js";

describe("Codex CLI status output", () => {
  it("extracts the rendered /status panel from ANSI terminal output", () => {
    const output = [
      "\u001b[?2026h",
      "\u001b[;m/status\u001b[m",
      "\u001b[2m╭────────────────────────────╮\u001b[m",
      "\u001b[2m│ >_ \u001b[22m\u001b[1mOpenAI Codex\u001b[22m\u001b[2m (v0.139.0) │\u001b[m",
      "\u001b[2m│ Model: \u001b[22mgpt-5.5\u001b[2m (reasoning high) │\u001b[m",
      "\u001b[2m│ Account: \u001b[22muser@example.com (Pro)\u001b[2m │\u001b[m",
      "\u001b[2m│ Session: \u001b[22m019eb26c-status\u001b[2m │\u001b[m",
      "\u001b[2m│ 5h limit: \u001b[22m[████░] 85% left\u001b[2m (resets 21:09) │\u001b[m",
      "\u001b[2m│ Weekly limit: \u001b[22m[██░░] 15% left\u001b[2m │\u001b[m",
      "\u001b[2m╰────────────────────────────╯\u001b[m",
      "\u001b[1m›\u001b[22m Run /review on my current changes",
    ].join("\n");

    assert.equal(extractCodexStatusPanel(output), [
      ">_ OpenAI Codex (v0.139.0)",
      "Model: gpt-5.5 (reasoning high)",
      "Account: user@example.com (Pro)",
      "Session: 019eb26c-status",
      "5h limit: [████░] 85% left (resets 21:09)",
      "Weekly limit: [██░░] 15% left",
    ].join("\n"));
  });

  it("formats extracted status as a WhatsApp-friendly tool result", () => {
    assert.equal(
      formatCodexStatusForReply([
        ">_ OpenAI Codex (v0.139.0)",
        "Model: gpt-5.5",
        "Weekly limit: [██░░] 15% left",
      ].join("\n")),
      [
        "Codex status:",
        "```",
        ">_ OpenAI Codex (v0.139.0)",
        "Model: gpt-5.5",
        "Weekly limit: [██░░] 15% left",
        "```",
      ].join("\n"),
    );
  });
});
