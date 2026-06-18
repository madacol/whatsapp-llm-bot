import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const guardedFiles = [
  "commands/bang-command-router.js",
  "commands/command-results.js",
  "conversation/build-agent-io-hooks.js",
  "conversation/codex-hook-display.js",
  "conversation/create-conversation-runner.js",
  "conversation/prepare-run-messages.js",
  "harnesses/acp.js",
  "session-control-commands.js",
  "slash-diff-command.js",
  "workspace-command-router.js",
];

const contentEventAllowedFiles = new Set([
  "outbound-events.js",
]);

const legacyContentEventCompatibilityFiles = new Set([
  "outbound-events.js",
  "types.d.ts",
  "http-api-transport-ledger.js",
  "whatsapp/outbound/persistent-queue.js",
  "whatsapp/outbound/queue-store.js",
  "whatsapp/outbound/send-content.js",
]);

/**
 * @param {string} dir
 * @returns {string[]}
 */
function listProjectFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === ".git"
      || entry.name === "node_modules"
      || entry.name === "coverage"
      || entry.name === "tmp"
    ) {
      continue;
    }
    const absolutePath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listProjectFiles(absolutePath));
      continue;
    }
    if (/\.(?:js|ts|d\.ts)$/.test(entry.name)) {
      files.push(relative(repoRoot, absolutePath));
    }
  }
  return files;
}

describe("output port boundaries", () => {
  it("keeps app and agent-run producers off raw outbound event constructors", () => {
    const violations = [];

    for (const file of guardedFiles) {
      const absolutePath = join(repoRoot, file);
      const source = readFileSync(absolutePath, "utf8");
      if (/from\s+["'](?:\.\.?\/)+outbound-events\.js["']/.test(source)) {
        violations.push(relative(repoRoot, absolutePath));
      }
    }

    assert.deepEqual(violations, []);
  });

  it("keeps legacy content event construction quarantined", () => {
    const output = readFileSync(join(repoRoot, "outbound-events.js"), "utf8");
    assert.match(output, /export function contentEvent/);

    const result = [];
    for (const file of [
      "agent-run-output-port.js",
      "app-output-port.js",
      "commands/restart-command.js",
      "conversation/build-agent-io-hooks.js",
      "http-api-transport.js",
      "http-api-transport-ledger.js",
      "whatsapp/outbound/send-content.js",
      "whatsapp/workspace-presenter.js",
    ]) {
      const source = readFileSync(join(repoRoot, file), "utf8");
      if (/\bcontentEvent\s*\(/.test(source) && !contentEventAllowedFiles.has(file)) {
        result.push(file);
      }
    }

    assert.deepEqual(result, []);
  });

  it("marks ContentEvent as legacy compatibility", () => {
    const types = readFileSync(join(repoRoot, "types.d.ts"), "utf8");

    assert.match(types, /@deprecated[^\n]*legacy compatibility[^\n]*ContentEvent[\s\S]*type ContentEvent = \{/);
  });

  it("accepts legacy content events only in compatibility infrastructure", () => {
    const violations = [];

    for (const file of listProjectFiles(repoRoot)) {
      if (file.startsWith("tests/")) {
        continue;
      }
      if (legacyContentEventCompatibilityFiles.has(file)) {
        continue;
      }
      const source = readFileSync(join(repoRoot, file), "utf8");
      if (/\bkind\s*:\s*["']content["']/.test(source)) {
        violations.push(file);
      }
    }

    assert.deepEqual(violations, []);
  });
});
