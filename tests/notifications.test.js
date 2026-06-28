import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { needsAuthReset } from "../notifications.js";

/**
 * @param {number} statusCode
 * @returns {{ error: Error & { output?: { statusCode?: number }, isBoom?: boolean } }}
 */
function boomError(statusCode) {
  /** @type {Error & { output?: { statusCode?: number }, isBoom?: boolean }} */
  const error = new Error(`status ${statusCode}`);
  error.output = { statusCode };
  error.isBoom = true;
  return { error };
}

describe("needsAuthReset", () => {
  it("returns true for auth failure codes (401, 403, 405, 419)", () => {
    for (const code of [401, 403, 405, 419]) {
      assert.equal(needsAuthReset(boomError(code)), true, `expected true for ${code}`);
    }
  });

  it("returns false for non-auth errors (408, 428, 515)", () => {
    for (const code of [408, 428, 515]) {
      assert.equal(needsAuthReset(boomError(code)), false, `expected false for ${code}`);
    }
  });

  it("returns false when error data is missing or malformed", () => {
    assert.equal(needsAuthReset(undefined), false);
    assert.equal(needsAuthReset({ error: undefined }), false);
    assert.equal(needsAuthReset({ error: new Error("some error") }), false);
  });
});
