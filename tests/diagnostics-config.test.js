import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntimeDiagnosticsState } from "../diagnostics-config.js";

describe("runtime diagnostics config", () => {
  it("uses environment defaults until the runtime config file overrides them", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "diagnostics-config-"));
    const configPath = path.join(tempDir, "logging.json");
    const state = createRuntimeDiagnosticsState({
      configPath,
      env: {
        MADABOT_ACP_PROTOCOL_LOG: "1",
        MADABOT_RAW_EVENT_LOG: "0",
      },
      reloadIntervalMs: 0,
    });

    assert.equal(state.isAcpProtocolLogEnabled(), true);
    assert.equal(state.isRawEventLogEnabled(), false);

    await fs.writeFile(configPath, JSON.stringify({ acpProtocolLog: false, rawEventLog: true }));

    assert.equal(state.isAcpProtocolLogEnabled(), false);
    assert.equal(state.isRawEventLogEnabled(), true);
  });

  it("persists runtime logging changes and reflects them without recreating state", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "diagnostics-config-"));
    const configPath = path.join(tempDir, "logging.json");
    const state = createRuntimeDiagnosticsState({ configPath, env: {}, reloadIntervalMs: 0 });

    assert.equal(state.isAcpProtocolLogEnabled(), false);
    assert.equal(state.isRawEventLogEnabled(), false);

    await state.update({ acpProtocolLog: true });

    assert.equal(state.isAcpProtocolLogEnabled(), true);
    assert.equal(state.isRawEventLogEnabled(), false);
    assert.deepEqual(JSON.parse(await fs.readFile(configPath, "utf8")), {
      acpProtocolLog: true,
      rawEventLog: false,
    });

    await state.update({ rawEventLog: true, acpProtocolLog: false });

    assert.equal(state.isAcpProtocolLogEnabled(), false);
    assert.equal(state.isRawEventLogEnabled(), true);
  });
});
