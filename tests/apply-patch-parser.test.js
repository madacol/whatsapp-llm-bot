import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { extractApplyPatchTargetPaths } from "../harnesses/apply-patch-parser.js";

describe("apply patch parser", () => {
  it("extracts add, update, delete, and move target paths from raw patch input", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/app.js",
      "@@",
      "-old",
      "+new",
      "*** Delete File: /tmp/old.md",
      "*** Add File: /tmp/new.md",
      "+# New",
      "*** Update File: docs/source.md",
      "*** Move to: docs/target.md",
      "@@",
      "-source",
      "+target",
      "*** End Patch",
    ].join("\n");

    assert.deepEqual(extractApplyPatchTargetPaths({ patch }), [
      "src/app.js",
      "/tmp/old.md",
      "/tmp/new.md",
      "docs/source.md",
      "docs/target.md",
    ]);
  });

  it("returns no paths when raw input does not contain an apply_patch payload", () => {
    assert.deepEqual(extractApplyPatchTargetPaths({ command: "git status" }), []);
  });
});
