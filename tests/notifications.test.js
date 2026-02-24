import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isSessionRejected } from "../notifications.js";

describe("isSessionRejected", () => {
  it("returns true for 405 status code error", () => {
    const error = {
      output: { statusCode: 405 },
      data: { reason: "405", location: "cln" },
      isBoom: true,
    };
    assert.equal(isSessionRejected({ error }), true);
  });

  it("returns true for 405 with different location", () => {
    const error = {
      output: { statusCode: 405 },
      data: { reason: "405", location: "frc" },
      isBoom: true,
    };
    assert.equal(isSessionRejected({ error }), true);
  });

  it("returns false for non-405 errors", () => {
    const error = {
      output: { statusCode: 401 },
      data: { reason: "401" },
      isBoom: true,
    };
    assert.equal(isSessionRejected({ error }), false);
  });

  it("returns false for connection lost (408)", () => {
    const error = {
      output: { statusCode: 408 },
      isBoom: true,
    };
    assert.equal(isSessionRejected({ error }), false);
  });

  it("returns false when lastDisconnect is undefined", () => {
    assert.equal(isSessionRejected(undefined), false);
  });

  it("returns false when error is undefined", () => {
    assert.equal(isSessionRejected({ error: undefined }), false);
  });

  it("returns false when output is missing", () => {
    const error = { message: "some error" };
    assert.equal(isSessionRejected({ error }), false);
  });
});
