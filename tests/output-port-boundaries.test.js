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
});
