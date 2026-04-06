import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureClaudeProjectSkillsLink } from "../project-skills.js";

describe("ensureClaudeProjectSkillsLink", () => {
  it("creates a .claude/skills symlink pointing at .agents/skills", async () => {
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "project-skills-"));

    await ensureClaudeProjectSkillsLink(workdir);

    const linkPath = path.join(workdir, ".claude/skills");
    const stats = await fs.lstat(linkPath);
    assert.equal(stats.isSymbolicLink(), true);
    assert.equal(await fs.readlink(linkPath), "../.agents/skills");
  });

  it("fails when .claude/skills already exists as a real directory", async () => {
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "project-skills-"));
    await fs.mkdir(path.join(workdir, ".claude/skills"), { recursive: true });

    await assert.rejects(
      ensureClaudeProjectSkillsLink(workdir),
      /Expected .*\.claude\/skills to be a symlink/,
    );
  });
});
