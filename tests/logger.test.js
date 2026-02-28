import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createLogger, LOG_LEVELS } from "../logger.js";

describe("createLogger", () => {
  /** @type {string | undefined} */
  let origLogLevel;
  /** @type {string | undefined} */
  let origTesting;

  beforeEach(() => {
    origLogLevel = process.env.LOG_LEVEL;
    origTesting = process.env.TESTING;
  });

  afterEach(() => {
    if (origLogLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = origLogLevel;
    if (origTesting === undefined) delete process.env.TESTING;
    else process.env.TESTING = origTesting;
  });

  it("returns an object with debug, info, warn, error methods", () => {
    const log = createLogger("test");
    assert.equal(typeof log.debug, "function");
    assert.equal(typeof log.info, "function");
    assert.equal(typeof log.warn, "function");
    assert.equal(typeof log.error, "function");
  });

  it("level hierarchy is debug < info < warn < error < silent", () => {
    assert.ok(LOG_LEVELS.debug < LOG_LEVELS.info);
    assert.ok(LOG_LEVELS.info < LOG_LEVELS.warn);
    assert.ok(LOG_LEVELS.warn < LOG_LEVELS.error);
    assert.ok(LOG_LEVELS.error < LOG_LEVELS.silent);
  });

  it("defaults to error level when TESTING=1", () => {
    process.env.TESTING = "1";
    delete process.env.LOG_LEVEL;
    const log = createLogger("test");

    const calls = captureLogs(() => {
      log.debug("hidden");
      log.info("hidden");
      log.warn("hidden");
      log.error("visible");
    });

    assert.equal(calls.debug.length, 0);
    assert.equal(calls.info.length, 0);
    assert.equal(calls.warn.length, 0);
    assert.equal(calls.error.length, 1);
  });

  it("defaults to info level when TESTING is not set", () => {
    delete process.env.TESTING;
    delete process.env.LOG_LEVEL;
    const log = createLogger("test");

    const calls = captureLogs(() => {
      log.debug("hidden");
      log.info("visible");
      log.warn("visible");
      log.error("visible");
    });

    assert.equal(calls.debug.length, 0);
    assert.equal(calls.info.length, 1);
    assert.equal(calls.warn.length, 1);
    assert.equal(calls.error.length, 1);
  });

  it("respects LOG_LEVEL override even when TESTING=1", () => {
    process.env.TESTING = "1";
    process.env.LOG_LEVEL = "debug";
    const log = createLogger("test");

    const calls = captureLogs(() => {
      log.debug("visible");
      log.info("visible");
    });

    assert.equal(calls.debug.length, 1);
    assert.equal(calls.info.length, 1);
  });

  it("silent level suppresses everything", () => {
    process.env.LOG_LEVEL = "silent";
    const log = createLogger("test");

    const calls = captureLogs(() => {
      log.debug("hidden");
      log.info("hidden");
      log.warn("hidden");
      log.error("hidden");
    });

    assert.equal(calls.debug.length, 0);
    assert.equal(calls.info.length, 0);
    assert.equal(calls.warn.length, 0);
    assert.equal(calls.error.length, 0);
  });

  it("prefixes output with label", () => {
    process.env.LOG_LEVEL = "debug";
    const log = createLogger("mymodule");

    const calls = captureLogs(() => {
      log.info("hello", "world");
    });

    assert.equal(calls.info.length, 1);
    assert.equal(calls.info[0][0], "[mymodule]");
    assert.equal(calls.info[0][1], "hello");
    assert.equal(calls.info[0][2], "world");
  });
});

/**
 * Capture console.log/warn/error/debug calls during fn execution.
 * @param {() => void} fn
 */
function captureLogs(fn) {
  /** @type {{ debug: any[][], info: any[][], warn: any[][], error: any[][] }} */
  const calls = { debug: [], info: [], warn: [], error: [] };
  const orig = {
    log: console.log,
    debug: console.debug,
    warn: console.warn,
    error: console.error,
  };

  console.debug = /** @type {typeof console.debug} */ ((...args) => calls.debug.push(args));
  console.log = /** @type {typeof console.log} */ ((...args) => calls.info.push(args));
  console.warn = /** @type {typeof console.warn} */ ((...args) => calls.warn.push(args));
  console.error = /** @type {typeof console.error} */ ((...args) => calls.error.push(args));

  try {
    fn();
  } finally {
    console.log = orig.log;
    console.debug = orig.debug;
    console.warn = orig.warn;
    console.error = orig.error;
  }

  return calls;
}
