import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildNodeTestArgs,
  isExplicitTestTarget,
} from "../scripts/test-runner.js";

describe("isExplicitTestTarget", () => {
  it("treats test file paths as explicit targets", () => {
    assert.equal(isExplicitTestTarget("tests/codex-runner.test.js"), true);
  });

  it("does not treat node test flags as explicit targets", () => {
    assert.equal(isExplicitTestTarget("--test-name-pattern"), false);
  });

  it("does not treat test-name patterns as explicit targets", () => {
    assert.equal(isExplicitTestTarget("startup failures"), false);
  });
});

describe("buildNodeTestArgs", () => {
  it("uses default test files when no explicit target is provided", () => {
    assert.deepEqual(buildNodeTestArgs(["--test-name-pattern", "startup"], {
      defaultTestFiles: ["tests/a.test.js", "tests/b.test.js"],
    }), [
      "--test",
      "--experimental-test-isolation=none",
      "--test-name-pattern",
      "startup",
      "tests/a.test.js",
      "tests/b.test.js",
    ]);
  });

  it("uses only explicit targets when files are passed", () => {
    assert.deepEqual(buildNodeTestArgs(["tests/codex-runner.test.js"], {
      defaultTestFiles: ["tests/a.test.js", "tests/b.test.js"],
    }), [
      "--test",
      "--experimental-test-isolation=none",
      "tests/codex-runner.test.js",
    ]);
  });

  it("adds watch mode when requested", () => {
    assert.deepEqual(buildNodeTestArgs([], {
      defaultTestFiles: ["tests/a.test.js"],
      watch: true,
    }), [
      "--test",
      "--experimental-test-isolation=none",
      "--watch",
      "tests/a.test.js",
    ]);
  });
});
