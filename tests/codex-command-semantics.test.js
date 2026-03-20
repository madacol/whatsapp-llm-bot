import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { analyzeCodexCommand } from "../harnesses/codex-command-semantics.js";

describe("analyzeCodexCommand", () => {
  it("identifies direct file reads", () => {
    assert.deepEqual(analyzeCodexCommand("sed -n '1,40p' src/app.js"), {
      readPaths: ["src/app.js"],
      snapshotPaths: ["src/app.js"],
      patches: [],
    });
  });

  it("extracts patch diffs and snapshot paths from apply_patch", () => {
    const result = analyzeCodexCommand([
      "apply_patch <<'PATCH'",
      "*** Begin Patch",
      "*** Update File: src/app.js",
      "@@",
      "-old",
      "+new",
      "*** Add File: src/new.js",
      "+export const value = 1;",
      "*** End Patch",
      "PATCH",
    ].join("\n"));

    assert.deepEqual(result, {
      readPaths: [],
      snapshotPaths: ["src/app.js", "src/new.js"],
      patches: [
        {
          path: "src/app.js",
          kind: "update",
          diff: ["--- a/src/app.js", "+++ b/src/app.js", "@@", "-old", "+new"].join("\n"),
        },
        {
          path: "src/new.js",
          kind: "add",
          diff: ["--- /dev/null", "+++ b/src/new.js", "@@ -0,0 +1,1 @@", "+export const value = 1;"].join("\n"),
        },
      ],
    });
  });
});
