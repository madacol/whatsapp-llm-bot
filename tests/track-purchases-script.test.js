import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * @param {string[]} args
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
function runTrackPurchasesScript(args) {
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env };
  delete env.TESTING;

  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["scripts/track-purchases.js", ...args],
      { cwd: process.cwd(), env },
      (error, stdout, stderr) => {
        if (error) {
          const wrapped = new Error(stderr || stdout || error.message);
          reject(wrapped);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

describe("track-purchases CLI", () => {
  it("registers a purchase and reads it back from the same database path", async (t) => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "track-purchases-cli-"));
    t.after(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    const dbPath = path.join(tmpDir, "action-db");
    const inputPath = path.join(tmpDir, "receipt.json");

    await writeFile(inputPath, JSON.stringify({
      storeName: "CLI Market",
      purchaseDate: "2026-04-06",
      ledgerName: "Groceries",
      receiptTotal: 6.7,
      items: [
        { item_name: "Pan", quantity: 1, unit_price: 1.20, subtotal: 1.20 },
        { item_name: "Agua", quantity: 2, unit_price: 0.50, subtotal: 1.00 },
        { item_name: "Queso", quantity: 1, unit_price: 4.50, subtotal: 4.50 },
      ],
      discounts: [],
    }, null, 2));

    const registerResult = await runTrackPurchasesScript([
      "register",
      "--db-path", dbPath,
      "--input-file", inputPath,
      "--yes",
    ]);
    assert.match(registerResult.stdout, /CLI Market/);
    assert.match(registerResult.stdout, /Factura registrada/);

    const historyResult = await runTrackPurchasesScript([
      "history",
      "--db-path", dbPath,
      "--ledger-name", "Groceries",
    ]);
    assert.match(historyResult.stdout, /CLI Market/);
    assert.match(historyResult.stdout, /Pan/);
    assert.match(historyResult.stdout, /6\.70/);
  });
});
