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
