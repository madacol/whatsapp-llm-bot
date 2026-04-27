import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSdkErrorResponse,
  clearStaleHarnessSession,
  getHarnessRunErrorMessage,
  isReportedHarnessRunError,
  isTransientHarnessRunError,
  reportHarnessRunError,
} from "../harnesses/harness-run-errors.js";

describe("reportHarnessRunError", () => {
  it("reports an unhandled error and marks it as reported", async () => {
    /** @type {string[]} */
    const errors = [];
    const reported = await reportHarnessRunError(new Error("boom"), async (message) => {
      errors.push(message);
    });

    assert.equal(isReportedHarnessRunError(reported), true);
    assert.equal(getHarnessRunErrorMessage(reported), "boom");
    assert.deepEqual(errors, ["boom"]);
  });

  it("does not re-report an already reported error", async () => {
    /** @type {string[]} */
    const errors = [];
    const once = await reportHarnessRunError(new Error("boom"), async (message) => {
      errors.push(message);
    });
    const twice = await reportHarnessRunError(once, async (message) => {
      errors.push(message);
    });

    assert.equal(twice, once);
    assert.deepEqual(errors, ["boom"]);
  });
});

describe("buildSdkErrorResponse", () => {
  it("formats a text response with the sdk prefix", () => {
    assert.deepEqual(buildSdkErrorResponse("boom"), [{
      type: "text",
      text: "SDK error: boom",
    }]);
  });
});

describe("clearStaleHarnessSession", () => {
  it("clears a saved unresolved session after a failed run", async () => {
    /** @type {string[]} */
    const calls = [];
    const cleared = await clearStaleHarnessSession({
      existingSessionId: "sess-123",
      resolvedSessionId: null,
      clearSession: async () => {
        calls.push("clear");
      },
      log: {
        warn: (...args) => {
          calls.push(String(args[0]));
        },
        error: (...args) => {
          calls.push(String(args[0]));
        },
      },
      harnessLabel: "Codex",
    });

    assert.equal(cleared, true);
    assert.equal(calls[0], "Codex run failed for saved session sess-123; clearing persisted session");
    assert.equal(calls[1], "clear");
  });

  it("does nothing when the session was resolved", async () => {
    /** @type {string[]} */
    const calls = [];
    const cleared = await clearStaleHarnessSession({
      existingSessionId: "sess-123",
      resolvedSessionId: "sess-456",
      clearSession: async () => {
        calls.push("clear");
      },
      log: {
        warn: (...args) => {
          calls.push(String(args[0]));
        },
        error: (...args) => {
          calls.push(String(args[0]));
        },
      },
      harnessLabel: "Claude SDK",
    });

    assert.equal(cleared, false);
    assert.deepEqual(calls, []);
  });

  it("does not clear a saved session for transient connection failures", async () => {
    /** @type {string[]} */
    const calls = [];
    const cleared = await clearStaleHarnessSession({
      existingSessionId: "sess-123",
      resolvedSessionId: null,
      error: new Error("Connection Closed"),
      clearSession: async () => {
        calls.push("clear");
      },
      log: {
        warn: (...args) => {
          calls.push(String(args[0]));
        },
        error: (...args) => {
          calls.push(String(args[0]));
        },
      },
      harnessLabel: "Codex",
    });

    assert.equal(cleared, false);
    assert.deepEqual(calls, []);
  });

  it("does not clear a saved session for provider rate limits", async () => {
    /** @type {string[]} */
    const calls = [];
    const cleared = await clearStaleHarnessSession({
      existingSessionId: "sess-123",
      resolvedSessionId: null,
      error: new Error("API Error: Rate limit reached"),
      clearSession: async () => {
        calls.push("clear");
      },
      log: {
        warn: (...args) => {
          calls.push(String(args[0]));
        },
        error: (...args) => {
          calls.push(String(args[0]));
        },
      },
      harnessLabel: "Codex",
    });

    assert.equal(cleared, false);
    assert.deepEqual(calls, []);
  });
});

describe("isTransientHarnessRunError", () => {
  it("matches recoverable provider errors without matching ordinary failures", () => {
    assert.equal(isTransientHarnessRunError(new Error("Connection Closed")), true);
    assert.equal(isTransientHarnessRunError(new Error("Codex app-server connection closed.")), true);
    assert.equal(isTransientHarnessRunError(new Error("API Error: Rate limit reached")), true);
    assert.equal(isTransientHarnessRunError(new Error("429: rate_limit_exceeded")), true);
    assert.equal(isTransientHarnessRunError(new Error("invalid session")), false);
  });
});
