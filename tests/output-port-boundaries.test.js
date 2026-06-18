import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
});
