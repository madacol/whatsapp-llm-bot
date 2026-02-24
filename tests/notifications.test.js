import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { needsAuthReset } from "../notifications.js";

describe("needsAuthReset", () => {
  it("returns true for 405 (session rejected)", () => {
    const error = {
      output: { statusCode: 405 },
      data: { reason: "405", location: "cln" },
      isBoom: true,
    };
    assert.equal(needsAuthReset({ error }), true);
  });

  it("returns true for 401 (logged out)", () => {
    const error = {
      output: { statusCode: 401 },
      data: { reason: "401", location: "lla" },
      isBoom: true,
    };
    assert.equal(needsAuthReset({ error }), true);
  });

  it("returns true for 403 (forbidden)", () => {
    const error = {
      output: { statusCode: 403 },
      isBoom: true,
    };
    assert.equal(needsAuthReset({ error }), true);
  });

  it("returns true for 419 (auth expired)", () => {
    const error = {
      output: { statusCode: 419 },
      isBoom: true,
    };
    assert.equal(needsAuthReset({ error }), true);
  });

  it("returns false for connection lost (408)", () => {
    const error = {
      output: { statusCode: 408 },
      isBoom: true,
    };
    assert.equal(needsAuthReset({ error }), false);
  });

  it("returns false for connection closed (428)", () => {
    const error = {
      output: { statusCode: 428 },
      isBoom: true,
    };
    assert.equal(needsAuthReset({ error }), false);
  });

  it("returns false for restart required (515)", () => {
    const error = {
      output: { statusCode: 515 },
      isBoom: true,
    };
    assert.equal(needsAuthReset({ error }), false);
  });

  it("returns false when lastDisconnect is undefined", () => {
    assert.equal(needsAuthReset(undefined), false);
  });

  it("returns false when error is undefined", () => {
    assert.equal(needsAuthReset({ error: undefined }), false);
  });

  it("returns false when output is missing", () => {
    const error = { message: "some error" };
    assert.equal(needsAuthReset({ error }), false);
  });
});
