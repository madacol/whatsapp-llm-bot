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
        MADABOT_ACP_STDERR_LOG: "1",
        MADABOT_RAW_EVENT_LOG: "0",
        DB_DIAGNOSTICS: "1",
        LOG_LEVEL: "warn",
      },
      legacyWhatsAppDiagnosticEnabled: true,
      reloadIntervalMs: 0,
    });

    assert.equal(state.isAcpProtocolLogEnabled(), true);
    assert.equal(state.isAcpStderrLogEnabled(), true);
    assert.equal(state.isRawEventLogEnabled(), false);
    assert.equal(state.isDbCacheLogEnabled(), true);
    assert.equal(state.isWhatsAppUpsertLogEnabled(), true);
    assert.equal(state.isWhatsAppReactionLogEnabled(), true);
    assert.equal(state.isWhatsAppOutboundLogEnabled(), false);
    assert.equal(state.getConfig().logLevel, "warn");

    await fs.writeFile(configPath, JSON.stringify({
      acpProtocolLog: false,
      acpStderrLog: false,
      rawEventLog: true,
      dbCacheLog: false,
      whatsappUpsertLog: false,
      whatsappReactionLog: true,
      whatsappOutboundLog: true,
      logLevel: "debug",
    }));

    assert.equal(state.isAcpProtocolLogEnabled(), false);
    assert.equal(state.isAcpStderrLogEnabled(), false);
    assert.equal(state.isRawEventLogEnabled(), true);
    assert.equal(state.isDbCacheLogEnabled(), false);
    assert.equal(state.isWhatsAppUpsertLogEnabled(), false);
    assert.equal(state.isWhatsAppReactionLogEnabled(), true);
    assert.equal(state.isWhatsAppOutboundLogEnabled(), true);
    assert.equal(state.getConfig().logLevel, "debug");
  });

  it("persists runtime logging changes and reflects them without recreating state", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "diagnostics-config-"));
    const configPath = path.join(tempDir, "logging.json");
    const state = createRuntimeDiagnosticsState({
      configPath,
      env: {},
      legacyWhatsAppDiagnosticEnabled: false,
      reloadIntervalMs: 0,
    });

    assert.equal(state.isAcpProtocolLogEnabled(), false);
    assert.equal(state.isRawEventLogEnabled(), false);

    await state.update({ acpProtocolLog: true });

    assert.equal(state.isAcpProtocolLogEnabled(), true);
    assert.equal(state.isRawEventLogEnabled(), false);
    assert.deepEqual(JSON.parse(await fs.readFile(configPath, "utf8")), {
      acpProtocolLog: true,
      acpStderrLog: false,
      rawEventLog: false,
      dbCacheLog: false,
      whatsappUpsertLog: false,
      whatsappReactionLog: false,
      whatsappOutboundLog: false,
      logLevel: null,
    });

    await state.update({ rawEventLog: true, acpProtocolLog: false, logLevel: "error" });

    assert.equal(state.isAcpProtocolLogEnabled(), false);
    assert.equal(state.isRawEventLogEnabled(), true);
    assert.equal(state.getConfig().logLevel, "error");
  });
});
