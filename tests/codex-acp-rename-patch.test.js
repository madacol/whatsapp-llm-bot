import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { codexAcpEntryPoint } from "./codex-acp-patch-fixture.js";

const patchPath = new URL("../patches/@agentclientprotocol__codex-acp@0.0.44.patch", import.meta.url);

describe("patched codex-acp rename patch handling", () => {
  it("keeps unsupported Moved to metadata out of the bundled diff parser path", async () => {
    const bundle = await fs.readFile(codexAcpEntryPoint, "utf8");
    const patch = await fs.readFile(patchPath, "utf8");

    for (const source of [bundle, patch]) {
      assert.match(source, /function extractMoveTargetPathFromDiff\(diff\)/);
      assert.match(source, /function stripUnsupportedPatchMetadata\(diff\)/);
      assert.match(source, /!line\.startsWith\("Moved to: "\)/);
      assert.match(source, /const patchDiff = stripUnsupportedPatchMetadata\(change\.diff\)/);
      assert.match(source, /newContent = applyPatch\(oldContent, patchDiff\)/);
      assert.match(source, /catch \{\s+return null;\s+\}/);
      assert.match(source, /path: moveTargetPath \?\? change\.path/);
      assert.match(source, /moveTargetPath \? \{ moveTargetPath \} : \{\}/);
    }
  });
});
