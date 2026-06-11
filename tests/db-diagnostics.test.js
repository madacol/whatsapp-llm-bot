import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntimeDiagnosticsState, setDefaultRuntimeDiagnosticsStateForTesting } from "../diagnostics-config.js";
import { getSqliteDb } from "../db.js";

describe("database diagnostics logging", () => {
  /** @type {string | undefined} */
  let originalTesting;

  beforeEach(() => {
    originalTesting = process.env.TESTING;
    delete process.env.TESTING;
  });

  afterEach(() => {
    if (originalTesting === undefined) delete process.env.TESTING;
    else process.env.TESTING = originalTesting;
    setDefaultRuntimeDiagnosticsStateForTesting(null);
  });

  it("uses the runtime diagnostics manager to log every DB open", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "db-diagnostics-"));
    const diagnostics = createRuntimeDiagnosticsState({
      configPath: path.join(tempDir, "logging.json"),
      env: {},
      reloadIntervalMs: 0,
    });
    setDefaultRuntimeDiagnosticsStateForTesting(diagnostics);

    await diagnostics.update({ dbCacheLog: true });
    const calls = captureWarnLogs(() => {
      getSqliteDb(path.join(tempDir, "loud.sqlite"));
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.[0], "[db]");
    assert.equal(calls[0]?.[1], "database cache growth:");
  });
});

/**
 * @param {() => void} fn
 * @returns {unknown[][]}
 */
function captureWarnLogs(fn) {
  /** @type {unknown[][]} */
  const calls = [];
  const originalWarn = console.warn;
  console.warn = /** @type {typeof console.warn} */ ((...args) => calls.push(args));
  try {
    fn();
  } finally {
    console.warn = originalWarn;
  }
  return calls;
}
