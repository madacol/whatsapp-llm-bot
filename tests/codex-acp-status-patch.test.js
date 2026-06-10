import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { codexAcpEntryPoint } from "./codex-acp-patch-fixture.js";

describe("patched codex-acp status", () => {
  it("persists and reloads /status usage data for resumed sessions", async () => {
    const source = await fs.readFile(codexAcpEntryPoint, "utf8");

    assert.match(source, /MADABOT_CODEX_ACP_STATUS_CACHE/);
    assert.match(
      source,
      /handleTokenUsageUpdated\(params\) \{[\s\S]*this\.sessionState\.lastTokenUsage = toTokenCount\(params\.tokenUsage\.last\);[\s\S]*saveCachedSessionStatus\(this\.sessionState\);[\s\S]*\}/,
    );
    assert.match(
      source,
      /handleRateLimitsUpdated\(params\) \{[\s\S]*this\.sessionState\.rateLimits\.set\(limitId,[\s\S]*saveCachedSessionStatus\(this\.sessionState\);[\s\S]*\}/,
    );
    assert.match(
      source,
      /this\.sessions\.set\(sessionId, sessionState\);\s*applyCachedSessionStatus\(sessionState\);/,
    );
  });

  it("refreshes account rate limits before rendering /status", async () => {
    const source = await fs.readFile(codexAcpEntryPoint, "utf8");

    assert.match(
      source,
      /case "status": \{[\s\S]*await this\.refreshStatusData\(sessionState\);[\s\S]*const message = this\.buildStatusMessage\(sessionState\);/,
    );
    assert.match(
      source,
      /async refreshStatusData\(sessionState\) \{[\s\S]*this\.codexAcpClient\.getRateLimits\(\)[\s\S]*sessionState\.rateLimits = rateLimits;[\s\S]*saveCachedSessionStatus\(sessionState\);[\s\S]*\}/,
    );
    assert.match(
      source,
      /async accountRateLimitsRead\(\) \{[\s\S]*method: "account\/rateLimits\/read"/,
    );
  });
});
