import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractCodexStatusPanel, formatCodexStatusForReply, parseCodexStatusPanel } from "../harnesses/codex-cli-status.js";

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

  it("parses status fields and formats them like the old /status summary", () => {
    const parsed = parseCodexStatusPanel([
      ">_ OpenAI Codex (v0.139.0)",
      "Visit https://chatgpt.com/codex/settings/usage for up-to-date",
      "information on rate limits and credits",
      "Model: gpt-5.5 (reasoning high, summaries auto)",
      "Directory: ~/whatsapp-llm-bot",
      "Permissions: Workspace (Approve for me)",
      "Agents.md: /home/mada/.codex/AGENTS.md, AGENTS.md",
      "Account: madacol10@gmail.com (Pro)",
      "Collaboration mode: Default",
      "Session: 019eb2c4-454a-7653-8fb8-47899ac79a7d",
      "5h limit: [██████████████░░░░░░] 69% left (resets 21:09)",
      "Weekly limit: [███░░░░░░░░░░░░░░░░░] 13% left (resets 00:35 on 11 Jun)",
      "GPT-5.3-Codex-Spark limit:",
      "5h limit: [████████████████████] 100% left (resets 23:21)",
      "Weekly limit: [████████████████████] 100% left (resets 18:21 on 17 Jun)",
    ].join("\n"));

    assert.deepEqual(parsed, {
      model: "gpt-5.5 (reasoning high, summaries auto)",
      directory: "~/whatsapp-llm-bot",
      permissions: "Workspace (Approve for me)",
      agentsMd: "/home/mada/.codex/AGENTS.md, AGENTS.md",
      account: "madacol10@gmail.com (Pro)",
      collaborationMode: "Default",
      session: "019eb2c4-454a-7653-8fb8-47899ac79a7d",
      limits: [
        { label: "5h limit", value: "69% left (resets 21:09)" },
        { label: "Weekly limit", value: "13% left (resets 00:35 on 11 Jun)" },
        { label: "GPT-5.3-Codex-Spark 5h limit", value: "100% left (resets 23:21)" },
        { label: "GPT-5.3-Codex-Spark Weekly limit", value: "100% left (resets 18:21 on 17 Jun)" },
      ],
    });

    assert.equal(
      formatCodexStatusForReply([
        ">_ OpenAI Codex (v0.139.0)",
        "Model: gpt-5.5 (reasoning high, summaries auto)",
        "Directory: ~/whatsapp-llm-bot",
        "Permissions: Workspace (Approve for me)",
        "Agents.md: /home/mada/.codex/AGENTS.md, AGENTS.md",
        "Account: madacol10@gmail.com (Pro)",
        "Collaboration mode: Default",
        "Session: 019eb2c4-454a-7653-8fb8-47899ac79a7d",
        "5h limit: [████░] 85% left (resets 21:09)",
        "Weekly limit: [██░░] 15% left",
      ].join("\n")),
      [
        "Codex status:",
        "**Model:** gpt-5.5 (reasoning high, summaries auto)",
        "**Directory:** ~/whatsapp-llm-bot",
        "**Permissions:** Workspace (Approve for me)",
        "**Agents.md:** /home/mada/.codex/AGENTS.md, AGENTS.md",
        "**Account:** madacol10@gmail.com (Pro)",
        "**Collaboration mode:** Default",
        "**Session:** `019eb2c4-454a-7653-8fb8-47899ac79a7d`",
        "",
        "**5h limit:** 85% left (resets 21:09)",
        "**Weekly limit:** 15% left",
      ].join("\n"),
    );
  });

  it("falls back to the raw status panel when parsed formatting is unavailable", () => {
    assert.equal(
      formatCodexStatusForReply("unexpected raw status"),
      [
        "Codex status:",
        "```",
        "unexpected raw status",
        "```",
      ].join("\n"),
    );
  });
});
