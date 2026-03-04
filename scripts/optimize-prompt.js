#!/usr/bin/env node

/**
 * Prompt optimizer — uses a meta-LLM to iterate on prompt quality.
 *
 * Usage: npm run optimize-prompt -- <actionName> [--max-iterations=5] [--model=anthropic/claude-sonnet-4]
 */

import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "path";
import { parseArgs } from "node:util";
import dotenv from "dotenv";
import { createLlmClient, createCallLlm } from "../llm.js";

dotenv.config();

const fixturesDir = path.resolve(process.cwd(), "tests", "fixtures");

/**
 * Read a fixture file from tests/fixtures/ by name.
 * @param {string} name
 * @returns {Promise<Buffer>}
 */
async function readFixture(name) {
  return readFile(path.join(fixturesDir, name));
}

/**
 * @typedef {{name: string, passed: boolean, error?: string}} TestResult
 * @typedef {{passed: number, failed: number, results: TestResult[]}} TestRunSummary
 */

/**
 * Run test_prompts for an action with a given prompt function.
 * @param {Array<(callLlm: CallLlm, readFixture: (name: string) => Promise<Buffer>, prompt: (...args: any[]) => string) => Promise<void>>} prompts
 * @param {CallLlm} callLlm
 * @param {(...args: any[]) => string} promptFn
 * @returns {Promise<TestRunSummary>}
 */
async function runTestPrompts(prompts, callLlm, promptFn) {
  /** @type {TestResult[]} */
  const results = [];
  let passed = 0;
  let failed = 0;

  for (const fn of prompts) {
    const name = fn.name || "anonymous";
    try {
      await fn(callLlm, readFixture, promptFn);
      results.push({ name, passed: true });
      passed++;
    } catch (/** @type {unknown} */ err) {
      results.push({ name, passed: false, error: err instanceof Error ? err.message : String(err) });
      failed++;
    }
  }

  return { passed, failed, results };
}

/**
 * Ask a meta-LLM to improve the prompt based on test results.
 * @param {CallLlm} metaCallLlm
 * @param {string} currentText
 * @param {TestRunSummary} testResults
 * @param {string} actionDescription
 * @returns {Promise<string>}
 */
async function generateImprovedPrompt(metaCallLlm, currentText, testResults, actionDescription) {
  const failedTests = testResults.results
    .filter((r) => !r.passed)
    .map((r) => `- ${r.name}: ${r.error}`)
    .join("\n");

  /** @type {ContentBlock[]} */
  const prompt = [
    {
      type: "text",
      text: `You are a prompt engineering expert. Your task is to improve an LLM prompt used for: ${actionDescription}

Current prompt:
---
${currentText}
---

Test results (${testResults.passed} passed, ${testResults.failed} failed):
${failedTests ? `\nFailed tests:\n${failedTests}` : "\nAll tests passed."}

${testResults.failed > 0
    ? "Analyze the failures and return an improved version of the prompt that addresses these issues. Keep the same language (Spanish) and JSON output format. Return ONLY the improved prompt text, nothing else."
    : "All tests pass. Try to make the prompt more concise while keeping all tests passing. Return ONLY the improved prompt text, nothing else."
}`,
    },
  ];

  const response = await metaCallLlm(prompt);
  if (!response) {
    throw new Error("Meta-LLM returned empty response");
  }
  return response.trim();
}

/**
 * Main optimization loop.
 * @param {string} actionName
 * @param {{maxIterations: number, model?: string}} opts
 */
async function optimize(actionName, opts) {
  // Load the action and its test prompts
  const actionsDir = path.resolve(process.cwd(), "actions");
  /** @type {{default: Action}} */
  let mod;
  /** @type {Array<(callLlm: CallLlm, readFixture: (name: string) => Promise<Buffer>, prompt: (...args: any[]) => string) => Promise<void>>} */
  let testPrompts;
  try {
    mod = await import(`file://${path.join(actionsDir, actionName, "index.js")}`);
  } catch {
    console.error(`Could not load action file: actions/${actionName}/index.js`);
    process.exit(1);
  }
  try {
    const promptsMod = await import(`file://${path.join(actionsDir, actionName, "_test-prompts.js")}`);
    testPrompts = promptsMod.default;
  } catch {
    console.error(`Could not load test prompts: actions/${actionName}/_test-prompts.js`);
    process.exit(1);
  }

  const action = mod.default;
  if (!action?.prompt) {
    console.error(`Action "${actionName}" does not have a prompt function.`);
    process.exit(1);
  }
  if (!testPrompts?.length) {
    console.error(`Action "${actionName}" does not have test_prompts.`);
    process.exit(1);
  }

  // Create LLM clients
  const llmClient = createLlmClient();
  const callLlm = createCallLlm(llmClient);

  const metaModel = opts.model ?? undefined;
  const metaCallLlm = createCallLlm(llmClient, metaModel);

  let currentPromptText = action.prompt();
  /** @type {(...args: any[]) => string} */
  let currentPromptFn = () => currentPromptText;

  console.log(`Optimizing prompt for action: ${action.name}`);
  console.log(`Max iterations: ${opts.maxIterations}`);
  if (metaModel) console.log(`Meta-LLM model: ${metaModel}`);
  console.log(`Running baseline tests...\n`);

  // Baseline run
  let bestResult = await runTestPrompts(testPrompts, callLlm, currentPromptFn);
  let bestPromptText = currentPromptText;
  let bestScore = bestResult.passed;

  console.log(`Baseline: ${bestResult.passed}/${bestResult.passed + bestResult.failed} passed`);
  for (const r of bestResult.results) {
    console.log(`  ${r.passed ? "PASS" : "FAIL"} ${r.name}${r.error ? `: ${r.error}` : ""}`);
  }

  if (bestResult.failed === 0) {
    console.log(`\nAll tests pass with baseline prompt. Will attempt to make it more concise.\n`);
  }

  for (let i = 1; i <= opts.maxIterations; i++) {
    console.log(`\n--- Iteration ${i}/${opts.maxIterations} ---`);

    try {
      const improvedText = await generateImprovedPrompt(
        metaCallLlm,
        currentPromptText,
        bestResult,
        action.description,
      );

      console.log(`Generated improved prompt (${improvedText.length} chars vs ${currentPromptText.length} chars)`);

      const improvedFn = () => improvedText;
      const result = await runTestPrompts(testPrompts, callLlm, improvedFn);

      console.log(`Result: ${result.passed}/${result.passed + result.failed} passed`);
      for (const r of result.results) {
        console.log(`  ${r.passed ? "PASS" : "FAIL"} ${r.name}${r.error ? `: ${r.error}` : ""}`);
      }

      if (result.passed > bestScore || (result.passed === bestScore && improvedText.length < bestPromptText.length)) {
        bestScore = result.passed;
        bestPromptText = improvedText;
        bestResult = result;
        currentPromptText = improvedText;
        console.log(`New best! (${bestScore} passed)`);
      } else {
        console.log(`No improvement, keeping previous best.`);
      }

      if (result.failed === 0) {
        console.log(`\nAll tests pass — stopping early.`);
        break;
      }
    } catch (/** @type {unknown} */ err) {
      console.error(`Iteration ${i} error: ${err instanceof Error ? err.message : err}`);
    }
  }

  const originalPromptText = action.prompt();

  if (bestPromptText === originalPromptText) {
    console.log(`\nPrompt unchanged from original.`);
    return;
  }

  // Show diff between original and optimized prompt
  const oldTmp = path.join(tmpdir(), `prompt-old-${Date.now()}.txt`);
  const newTmp = path.join(tmpdir(), `prompt-new-${Date.now()}.txt`);
  await writeFile(oldTmp, originalPromptText + "\n", "utf-8");
  await writeFile(newTmp, bestPromptText + "\n", "utf-8");

  console.log(`\n${"=".repeat(60)}`);
  console.log("DIFF (original → optimized):");
  console.log("=".repeat(60));
  try {
    // diff exits 1 when files differ, which is expected
    const diff = execFileSync("diff", ["-u", "--color=always", oldTmp, newTmp], { encoding: "utf-8" });
    console.log(diff);
  } catch (/** @type {unknown} */ e) {
    const execErr = /** @type {{ stdout?: string, message?: string }} */ (e);
    if (execErr.stdout) console.log(execErr.stdout);
    else if (execErr.message) console.log(execErr.message);
    else console.log(String(e));
  }
  console.log("=".repeat(60));

  // Ask user whether to apply
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("\nApply this prompt to the source file? [y/N] ");
  rl.close();

  if (answer.trim().toLowerCase() !== "y") {
    console.log("Skipped.");
    return;
  }

  // Write the improved prompt back to the source file
  const actionFilePath = path.join(actionsDir, actionName, "index.js");
  const source = await readFile(actionFilePath, "utf-8");

  const idx = source.indexOf(originalPromptText);
  if (idx === -1) {
    console.error(`Could not find the original prompt text in ${actionFilePath}. Apply manually.`);
    return;
  }

  // Ensure it's unique — only one occurrence
  const secondIdx = source.indexOf(originalPromptText, idx + 1);
  if (secondIdx !== -1) {
    console.error(`Original prompt text appears multiple times in ${actionFilePath}. Apply manually.`);
    return;
  }

  const updated = source.slice(0, idx) + bestPromptText + source.slice(idx + originalPromptText.length);
  await writeFile(actionFilePath, updated, "utf-8");
  console.log(`Wrote optimized prompt to ${actionFilePath}`);
}

// --- CLI ---
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "max-iterations": { type: "string", default: "5" },
    model: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help || positionals.length === 0) {
  console.log(`Usage: npm run optimize-prompt -- <actionName> [--max-iterations=5] [--model=anthropic/claude-sonnet-4]`);
  process.exit(0);
}

const actionName = positionals[0];
const maxIterations = parseInt(/** @type {string} */ (values["max-iterations"]), 10);

optimize(actionName, { maxIterations, model: values.model }).catch((err) => {
  console.error(err);
  process.exit(1);
});
