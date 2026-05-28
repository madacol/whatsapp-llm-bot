import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import config from "../config.js";

describe("config.MASTER_IDs", () => {
  /** @type {string | undefined} */
  let origMasterId;

  beforeEach(() => {
    origMasterId = process.env.MASTER_ID;
  });

  afterEach(() => {
    if (origMasterId === undefined) delete process.env.MASTER_ID;
    else process.env.MASTER_ID = origMasterId;
  });

  it("trims whitespace from comma-separated IDs", () => {
    process.env.MASTER_ID = "123, 456 , 789";
    assert.deepEqual(config.MASTER_IDs, ["123", "456", "789"]);
  });

  it("filters out empty strings from trailing commas", () => {
    process.env.MASTER_ID = "123,,456,";
    assert.deepEqual(config.MASTER_IDs, ["123", "456"]);
  });

  it("returns empty array when env var is unset", () => {
    delete process.env.MASTER_ID;
    assert.deepEqual(config.MASTER_IDs, []);
  });
});

describe("config.default_harness", () => {
  /** @type {string | undefined} */
  let origDefaultHarness;
  /** @type {string | undefined} */
  let origMadabotDefaultHarness;

  beforeEach(() => {
    origDefaultHarness = process.env.DEFAULT_HARNESS;
    origMadabotDefaultHarness = process.env.MADABOT_DEFAULT_HARNESS;
    delete process.env.DEFAULT_HARNESS;
    delete process.env.MADABOT_DEFAULT_HARNESS;
  });

  afterEach(() => {
    if (origDefaultHarness === undefined) delete process.env.DEFAULT_HARNESS;
    else process.env.DEFAULT_HARNESS = origDefaultHarness;
    if (origMadabotDefaultHarness === undefined) delete process.env.MADABOT_DEFAULT_HARNESS;
    else process.env.MADABOT_DEFAULT_HARNESS = origMadabotDefaultHarness;
  });

  it("defaults to codex", () => {
    assert.equal(config.default_harness, "codex");
  });

  it("can be overridden centrally", () => {
    process.env.DEFAULT_HARNESS = "claude";
    assert.equal(config.default_harness, "claude");
  });

  it("can be disabled centrally", () => {
    process.env.DEFAULT_HARNESS = "";
    assert.equal(config.default_harness, "");
  });

  it("supports the MADABOT_DEFAULT_HARNESS alias", () => {
    process.env.MADABOT_DEFAULT_HARNESS = "pi";
    assert.equal(config.default_harness, "pi");
  });
});
