import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntimeDiagnosticsState } from "../diagnostics-config.js";
import { createFixtureCapture } from "../diagnostics/capture.js";

describe("fixture capture substrate", () => {
  it("writes nothing when a seam is not enabled", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fixture-capture-off-"));
    const diagnostics = createRuntimeDiagnosticsState({
      configPath: path.join(tempDir, "logging.json"),
      env: {},
      reloadIntervalMs: 0,
    });
    const capture = createFixtureCapture({
      diagnosticsState: diagnostics,
      baseDir: path.join(tempDir, "capture"),
      now: () => new Date("2026-06-21T09:00:00.000Z"),
    });

    capture.capture({
      seam: "acp.protocol",
      direction: "client_to_agent",
      event: "session/prompt",
      payload: { jsonrpc: "2.0", method: "session/prompt" },
    });
    await capture.waitForIdle();

    await assert.rejects(fs.readdir(path.join(tempDir, "capture")), { code: "ENOENT" });
  });

  it("writes a per-seam rotated NDJSON file with one meta record", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fixture-capture-on-"));
    const diagnostics = createRuntimeDiagnosticsState({
      configPath: path.join(tempDir, "logging.json"),
      env: {},
      reloadIntervalMs: 0,
    });
    await diagnostics.update({
      capture: {
        seams: {
          "acp.protocol": {
            enabledUntil: "2026-06-21T09:05:00.000Z",
            rotateMinutes: 1,
            retentionHours: 24,
            queueLimit: 10,
          },
        },
      },
    });
    const capture = createFixtureCapture({
      diagnosticsState: diagnostics,
      baseDir: path.join(tempDir, "capture"),
      now: () => new Date("2026-06-21T09:00:10.000Z"),
    });

    capture.capture({
      seam: "acp.protocol",
      direction: "client_to_agent",
      event: "session/prompt",
      payload: { jsonrpc: "2.0", method: "session/prompt", params: { input: "hello" } },
    });
    capture.capture({
      seam: "acp.protocol",
      direction: "agent_to_client",
      event: "session/update",
      payload: { jsonrpc: "2.0", method: "session/update", params: { update: "hi" } },
    });
    await capture.waitForIdle();

    const filePath = path.join(tempDir, "capture", "acp-protocol.2026-06-21T09-00Z.ndjson");
    const records = await readNdjson(filePath);
    assert.equal(records.length, 3);
    assert.equal(records[0].recordType, "fixtureCapture.meta");
    assert.equal(records[0].seam, "acp.protocol");
    assert.equal(records[0].capPolicy.mode, "known-field-groups-only");
    assert.equal(records[1].recordType, "fixtureCapture.event");
    assert.equal(records[1].seq, 1);
    assert.equal(records[2].seq, 2);
  });

  it("caps configured known field groups with explicit truncation metadata", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fixture-capture-cap-"));
    const diagnostics = createRuntimeDiagnosticsState({
      configPath: path.join(tempDir, "logging.json"),
      env: {},
      reloadIntervalMs: 0,
    });
    await diagnostics.update({
      capture: {
        seams: {
          "whatsapp.inbound": {
            enabledUntil: "2026-06-21T09:05:00.000Z",
            rotateMinutes: 1,
            retentionHours: 24,
            queueLimit: 10,
            fieldPolicies: {
              jpegThumbnail: { capBytes: 8 },
            },
          },
        },
      },
    });
    const capture = createFixtureCapture({
      diagnosticsState: diagnostics,
      baseDir: path.join(tempDir, "capture"),
      now: () => new Date("2026-06-21T09:00:10.000Z"),
    });

    capture.capture({
      seam: "whatsapp.inbound",
      direction: "baileys_to_shell",
      event: "messages.upsert",
      payload: {
        messages: [
          {
            message: {
              imageMessage: {
                jpegThumbnail: "abcdefghijklmnopqrstuvwxyz",
                caption: "keep me",
              },
            },
          },
        ],
      },
    });
    await capture.waitForIdle();

    const [meta, event] = await readNdjson(path.join(tempDir, "capture", "whatsapp-inbound.2026-06-21T09-00Z.ndjson"));
    assert.deepEqual(meta.capPolicy.configuredFieldGroups, ["jpegThumbnail"]);
    const thumbnail = event.payload.messages[0].message.imageMessage.jpegThumbnail;
    assert.equal(thumbnail.__fixtureCaptureTruncated, true);
    assert.equal(thumbnail.__fixtureCaptureType, "string");
    assert.equal(thumbnail.originalChars, 26);
    assert.equal(thumbnail.head, "abcdef");
    assert.equal(thumbnail.tail, "yz");
    assert.equal(event.payload.messages[0].message.imageMessage.caption, "keep me");
  });

  it("lets a field group bypass caps while fullRawUntil is active", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fixture-capture-full-raw-"));
    const diagnostics = createRuntimeDiagnosticsState({
      configPath: path.join(tempDir, "logging.json"),
      env: {},
      reloadIntervalMs: 0,
    });
    await diagnostics.update({
      capture: {
        seams: {
          "whatsapp.inbound": {
            enabledUntil: "2026-06-21T09:05:00.000Z",
            rotateMinutes: 1,
            retentionHours: 24,
            queueLimit: 10,
            fieldPolicies: {
              jpegThumbnail: {
                capBytes: 8,
                fullRawUntil: "2026-06-21T09:01:00.000Z",
              },
            },
          },
        },
      },
    });
    const capture = createFixtureCapture({
      diagnosticsState: diagnostics,
      baseDir: path.join(tempDir, "capture"),
      now: () => new Date("2026-06-21T09:00:10.000Z"),
    });

    capture.capture({
      seam: "whatsapp.inbound",
      direction: "baileys_to_shell",
      event: "messages.upsert",
      payload: {
        messages: [{ message: { imageMessage: { jpegThumbnail: "abcdefghijklmnopqrstuvwxyz" } } }],
      },
    });
    await capture.waitForIdle();

    const [, event] = await readNdjson(path.join(tempDir, "capture", "whatsapp-inbound.2026-06-21T09-00Z.ndjson"));
    assert.equal(event.payload.messages[0].message.imageMessage.jpegThumbnail, "abcdefghijklmnopqrstuvwxyz");
  });

  it("drops newest records when a seam queue is full", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fixture-capture-overflow-"));
    const diagnostics = createRuntimeDiagnosticsState({
      configPath: path.join(tempDir, "logging.json"),
      env: {},
      reloadIntervalMs: 0,
    });
    await diagnostics.update({
      capture: {
        seams: {
          "acp.protocol": {
            enabledUntil: "2026-06-21T09:05:00.000Z",
            rotateMinutes: 1,
            retentionHours: 24,
            queueLimit: 1,
          },
        },
      },
    });
    const capture = createFixtureCapture({
      diagnosticsState: diagnostics,
      baseDir: path.join(tempDir, "capture"),
      now: () => new Date("2026-06-21T09:00:10.000Z"),
    });

    capture.capture({ seam: "acp.protocol", direction: "client_to_agent", event: "one", payload: { value: 1 } });
    capture.capture({ seam: "acp.protocol", direction: "client_to_agent", event: "two", payload: { value: 2 } });
    capture.capture({ seam: "acp.protocol", direction: "client_to_agent", event: "three", payload: { value: 3 } });
    await capture.waitForIdle();

    const records = await readNdjson(path.join(tempDir, "capture", "acp-protocol.2026-06-21T09-00Z.ndjson"));
    assert.deepEqual(records.map((record) => record.recordType), [
      "fixtureCapture.meta",
      "fixtureCapture.event",
      "fixtureCapture.status",
    ]);
    assert.equal(records[1].event, "one");
    assert.equal(records[2].droppedRecords, 2);
    assert.equal(records[2].dropReason, "queue_limit_exceeded");
  });

  it("prunes rotated files older than the seam retention window", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fixture-capture-retention-"));
    const captureDir = path.join(tempDir, "capture");
    await fs.mkdir(captureDir, { recursive: true });
    await fs.writeFile(path.join(captureDir, "acp-protocol.2026-06-21T08-00Z.ndjson"), "{}\n");
    const diagnostics = createRuntimeDiagnosticsState({
      configPath: path.join(tempDir, "logging.json"),
      env: {},
      reloadIntervalMs: 0,
    });
    await diagnostics.update({
      capture: {
        seams: {
          "acp.protocol": {
            enabledUntil: "2026-06-21T10:05:00.000Z",
            rotateMinutes: 1,
            retentionHours: 1,
            queueLimit: 10,
          },
        },
      },
    });
    const capture = createFixtureCapture({
      diagnosticsState: diagnostics,
      baseDir: captureDir,
      now: () => new Date("2026-06-21T10:00:00.000Z"),
    });

    capture.capture({ seam: "acp.protocol", direction: "client_to_agent", event: "session/prompt", payload: {} });
    await capture.waitForIdle();

    const files = await fs.readdir(captureDir);
    assert.equal(files.includes("acp-protocol.2026-06-21T08-00Z.ndjson"), false);
    assert.equal(files.includes("acp-protocol.2026-06-21T10-00Z.ndjson"), true);
  });
});

/**
 * @param {string} filePath
 * @returns {Promise<any[]>}
 */
async function readNdjson(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return text.trim().split("\n").map((line) => JSON.parse(line));
}
