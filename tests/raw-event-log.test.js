import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntimeDiagnosticsState } from "../diagnostics-config.js";
import { createRuntimeGatedRawEventLogger, getHarnessRawEventLogger } from "../harnesses/raw-event-log.js";

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

  it("provides a default logger that stays quiet unless explicitly enabled", () => {
    assert.notEqual(getHarnessRawEventLogger(), null);

    process.env.MADABOT_RAW_EVENT_LOG = "1";
    assert.notEqual(getHarnessRawEventLogger(), null);
  });

  it("observes runtime toggles without replacing the raw event logger", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "raw-event-log-"));
    const configPath = path.join(tempDir, "logging.json");
    const logger = createRuntimeGatedRawEventLogger(
      path.join(tempDir, "raw-events.ndjson"),
      createRuntimeDiagnosticsState({ configPath, env: {}, reloadIntervalMs: 0 }),
    );

    await logger.write({
      provider: "codex",
      type: "session.update",
      raw: { disabled: true },
    });
    assert.deepEqual((await fs.readdir(tempDir)).sort(), []);

    await fs.writeFile(configPath, JSON.stringify({ rawEventLog: true }));
    await logger.write({
      provider: "codex",
      type: "session.update",
      createdAt: "2026-06-11T12:10:00.000Z",
      raw: { enabled: true },
    });

    assert.deepEqual((await fs.readdir(tempDir)).sort(), [
      "logging.json",
      "raw-events.2026-06-11T12Z.ndjson",
    ]);
    assert.match(
      await fs.readFile(path.join(tempDir, "raw-events.2026-06-11T12Z.ndjson"), "utf8"),
      /"enabled":true/,
    );
  });
});
