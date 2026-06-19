import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CODEX_CLI_STATUS_COMMAND_INPUT,
  CODEX_CLI_STATUS_DEFAULT_PROMPT_INPUT,
  CODEX_CLI_STATUS_DEFAULT_TIMEOUT_MS,
  CODEX_CLI_STATUS_READY_FALLBACK_MS,
  CODEX_CLI_STATUS_SKIP_UPDATE_INPUT,
  extractCodexStatusPanel,
  formatCodexStatusForReply,
  getCodexCliStartupPromptResponse,
  isCodexCliReadyForInput,
  isCodexCliStartupPromptWaiting,
  parseCodexStatusPanel,
  summarizeCodexStatusFailureOutput,
} from "../harnesses/codex-cli-status.js";

describe("Codex CLI status output", () => {
  it("uses a generous default timeout for fresh interactive Codex startup", () => {
    assert.equal(CODEX_CLI_STATUS_DEFAULT_TIMEOUT_MS, 45_000);
    assert.equal(CODEX_CLI_STATUS_READY_FALLBACK_MS, 10_000);
  });

  it("clears existing prompt text before submitting the status command", () => {
    assert.equal(CODEX_CLI_STATUS_COMMAND_INPUT, "\u0015/status\r");
  });

  it("detects readiness only after the Codex input prompt is trailing", () => {
    assert.equal(isCodexCliReadyForInput([
      "\u001b[2m╭────────────────────────────╮\u001b[m",
      "\u001b[2m│ >_ \u001b[22m\u001b[1mOpenAI Codex\u001b[22m\u001b[2m (v0.139.0) │\u001b[m",
      "\u001b[2m│ Model: \u001b[22mgpt-5.5\u001b[2m │\u001b[m",
      "\u001b[2m╰────────────────────────────╯\u001b[m",
    ].join("\n")), false);

    assert.equal(isCodexCliReadyForInput([
      "\u001b[2m╭────────────────────────────╮\u001b[m",
      "\u001b[2m│ >_ \u001b[22m\u001b[1mOpenAI Codex\u001b[22m\u001b[2m (v0.139.0) │\u001b[m",
      "\u001b[2m╰────────────────────────────╯\u001b[m",
      "\u001b[1m›\u001b[22m ",
    ].join("\n")), true);
  });

  it("accepts the ready prompt when Codex renders footer text after it", () => {
    assert.equal(isCodexCliReadyForInput([
      "\u001b[2m│ >_ \u001b[22m\u001b[1mOpenAI Codex\u001b[22m\u001b[2m (v0.139.0) │\u001b[m",
      "\u001b[1m›\u001b[22m Summarize recent commits",
      "gpt-5.5 high · ~/whatsapp-llm-bot",
    ].join("\n")), true);
  });

  it("ignores stale prompt glyphs that are not the current input line", () => {
    assert.equal(isCodexCliReadyForInput([
      "\u001b[2m│ >_ \u001b[22m\u001b[1mOpenAI Codex\u001b[22m\u001b[2m (v0.139.0) │\u001b[m",
      "\u001b[1m›\u001b[22m old prompt line",
      "\u001b[2mLoading session...\u001b[m",
    ].join("\n")), false);

    assert.equal(isCodexCliReadyForInput([
      "\u001b[2m│ >_ \u001b[22m\u001b[1mOpenAI Codex\u001b[22m\u001b[2m (v0.139.0) │\u001b[m",
      "\u001b[1m›\u001b[22m Implement {feature}",
      "\u001b[2m• Booting MCP server: codex_apps (0s...)\u001b[m",
    ].join("\n")), false);
  });

  it("detects startup prompts that must be dismissed before /status", () => {
    const updatePrompt = [
      "✨ Update available!",
      "1. Update now (runs `npm install -g @openai/codex`)",
      "Press enter to continue",
    ].join("\n");
    assert.equal(isCodexCliStartupPromptWaiting(updatePrompt), true);
    assert.equal(getCodexCliStartupPromptResponse(updatePrompt), CODEX_CLI_STATUS_SKIP_UPDATE_INPUT);

    const repairPrompt = [
      "Codex couldn't start because its local database appears to be damaged.",
      "Repair Codex local data now? [y/N]:",
    ].join("\n");
    assert.equal(isCodexCliStartupPromptWaiting(repairPrompt), true);
    assert.equal(getCodexCliStartupPromptResponse(repairPrompt), CODEX_CLI_STATUS_DEFAULT_PROMPT_INPUT);

    const normalPrompt = [
      ">_ OpenAI Codex (v0.139.0)",
      "›",
    ].join("\n");
    assert.equal(isCodexCliStartupPromptWaiting(normalPrompt), false);
    assert.equal(getCodexCliStartupPromptResponse(normalPrompt), null);
  });

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

  it("falls back to the latest Codex panel when strict status fields changed", () => {
    const output = [
      "\u001b[2m╭────────────────────────────╮\u001b[m",
      "\u001b[2m│ >_ \u001b[22m\u001b[1mOpenAI Codex\u001b[22m\u001b[2m (v0.140.0) │\u001b[m",
      "\u001b[2m│ Usage: \u001b[22mtemporarily unavailable\u001b[2m │\u001b[m",
      "\u001b[2m│ Account: \u001b[22muser@example.com\u001b[2m │\u001b[m",
      "\u001b[2m╰────────────────────────────╯\u001b[m",
    ].join("\n");

    assert.equal(extractCodexStatusPanel(output), [
      ">_ OpenAI Codex (v0.140.0)",
      "Usage: temporarily unavailable",
      "Account: user@example.com",
    ].join("\n"));
  });

  it("does not treat the startup Codex panel as status output", () => {
    const output = [
      "\u001b[2m╭────────────────────────────────────────────╮\u001b[m",
      "\u001b[2m│ >_ \u001b[22m\u001b[1mOpenAI Codex\u001b[22m\u001b[2m (v0.139.0)                 │\u001b[m",
      "\u001b[2m│                                            │\u001b[m",
      "\u001b[2m│ model:     \u001b[22mgpt-5.5 high\u001b[2m   \u001b[22m/model\u001b[2m to change │\u001b[m",
      "\u001b[2m│ directory: \u001b[22m~/whatsapp-llm-bot\u001b[2m              │\u001b[m",
      "\u001b[2m╰────────────────────────────────────────────╯\u001b[m",
      "\u001b[1m›\u001b[22m ",
    ].join("\n");

    assert.throws(() => extractCodexStatusPanel(output), /did not contain a status panel/);
  });

  it("does not return a partially rendered status panel with account only", () => {
    const output = [
      "\u001b[2m╭────────────────────────────╮\u001b[m",
      "\u001b[2m│ >_ \u001b[22m\u001b[1mOpenAI Codex\u001b[22m\u001b[2m (v0.141.0) │\u001b[m",
      "\u001b[2m│ Model: \u001b[22mgpt-5.5\u001b[2m │\u001b[m",
      "\u001b[2m│ Account: \u001b[22muser@example.com\u001b[2m │\u001b[m",
    ].join("\n");

    assert.throws(() => extractCodexStatusPanel(output), /did not contain a status panel/);
  });

  it("summarizes cleaned terminal output for failures", () => {
    assert.equal(
      summarizeCodexStatusFailureOutput([
        "\u001b[31mCodex couldn't start\u001b[m",
        "Cause: attempt to write a readonly database",
      ].join("\n")),
      [
        "",
        "",
        "Last Codex CLI output:",
        "Codex couldn't start",
        "Cause: attempt to write a readonly database",
      ].join("\n"),
    );
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
