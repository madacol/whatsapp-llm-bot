import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getHarnessRawEventLogger } from "../harnesses/raw-event-log.js";

describe("default raw event logging", () => {
  /** @type {string | undefined} */
  let originalRawEventLog;

  beforeEach(() => {
    originalRawEventLog = process.env.MADABOT_RAW_EVENT_LOG;
    delete process.env.MADABOT_RAW_EVENT_LOG;
  });

  afterEach(() => {
    if (originalRawEventLog === undefined) delete process.env.MADABOT_RAW_EVENT_LOG;
    else process.env.MADABOT_RAW_EVENT_LOG = originalRawEventLog;
  });

  it("leaves raw harness event logging disabled unless explicitly enabled", () => {
    assert.equal(getHarnessRawEventLogger(), null);

    process.env.MADABOT_RAW_EVENT_LOG = "1";
    assert.notEqual(getHarnessRawEventLogger(), null);
  });
});
