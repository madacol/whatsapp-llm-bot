import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntimeDiagnosticsState } from "../diagnostics-config.js";

describe("runtime diagnostics config", () => {
  it("uses operational environment defaults until the runtime config file adds capture seams", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "diagnostics-config-"));
    const configPath = path.join(tempDir, "logging.json");
    const state = createRuntimeDiagnosticsState({
      configPath,
      env: {
        MADABOT_ACP_STDERR_LOG: "1",
        DB_DIAGNOSTICS: "1",
        LOG_LEVEL: "warn",
      },
      reloadIntervalMs: 0,
    });

    assert.equal(state.isAcpStderrLogEnabled(), true);
    assert.equal(state.isDbCacheLogEnabled(), true);
    assert.deepEqual(state.getConfig().capture, { seams: {} });
    assert.equal(state.getConfig().logLevel, "warn");

    await fs.writeFile(configPath, JSON.stringify({
      capture: {
        seams: {
          "acp.protocol": {
            enabledUntil: "2026-06-21T09:00:00.000Z",
            rotateMinutes: 5,
            retentionHours: 12,
            queueLimit: 20,
            fieldPolicies: {
              content: { capBytes: 1024 },
              unknownGroup: { capBytes: 10 },
            },
          },
        },
      },
      logLevel: "debug",
    }));

    assert.equal(state.isAcpStderrLogEnabled(), true);
    assert.equal(state.isDbCacheLogEnabled(), true);
    assert.deepEqual(state.getConfig().capture.seams["acp.protocol"], {
      enabledUntil: "2026-06-21T09:00:00.000Z",
      rotateMinutes: 5,
      retentionHours: 12,
      queueLimit: 20,
      fieldPolicies: {
        content: { capBytes: 1024 },
        unknownGroup: { capBytes: 10 },
      },
    });
    assert.equal(state.getConfig().logLevel, "debug");
  });

  it("persists runtime capture changes and reflects them without recreating state", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "diagnostics-config-"));
    const configPath = path.join(tempDir, "logging.json");
    const state = createRuntimeDiagnosticsState({
      configPath,
      env: {},
      reloadIntervalMs: 0,
    });

    assert.deepEqual(state.getConfig().capture, { seams: {} });

    await state.update({
      capture: {
        seams: {
          "whatsapp.inbound": {
            enabledUntil: "2026-06-21T09:00:00.000Z",
            fieldPolicies: {
              jpegThumbnail: { capBytes: 65536 },
            },
          },
        },
      },
    });

    assert.deepEqual(JSON.parse(await fs.readFile(configPath, "utf8")), {
      capture: {
        seams: {
          "whatsapp.inbound": {
            enabledUntil: "2026-06-21T09:00:00.000Z",
            fieldPolicies: {
              jpegThumbnail: { capBytes: 65536 },
            },
          },
        },
      },
      logLevel: null,
    });

    await state.update({ logLevel: "error" });

    assert.deepEqual(Object.keys(state.getConfig().capture.seams), ["whatsapp.inbound"]);
    assert.equal(state.getConfig().logLevel, "error");
  });
});
