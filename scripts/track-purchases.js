#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { getActionDb, getDb } from "../db.js";
import { readPurchaseRegistrationInput } from "../capabilities/purchases/input.js";
import { preparePurchaseRegistration } from "../capabilities/purchases/math.js";
import {
  formatDeletedLedgerResult,
  formatDeletedPurchaseResult,
  formatDeleteLedgerPreview,
  formatLedgerList,
  formatPurchaseHistory,
  formatPurchasePreview,
  formatPurchaseSummary,
  formatRegisteredPurchaseResult,
  formatRenamedLedgerResult,
} from "../capabilities/purchases/presentation.js";
import {
  deleteLedgerById,
  deletePurchaseById,
  ensurePurchasesSchema,
  getPurchaseHistory,
  getPurchaseSummary,
  listPurchaseLedgers,
  prepareLedgerDeletion,
  registerPreparedPurchase,
  renamePurchaseLedger,
} from "../capabilities/purchases/store.js";

/**
 * @typedef {"register" | "history" | "summary" | "delete" | "list-ledgers" | "rename-ledger" | "delete-ledger"} CliCommand
 */

/**
 * @param {string | undefined} command
 * @returns {command is CliCommand}
 */
function isCliCommand(command) {
  return command === "register"
    || command === "history"
    || command === "summary"
    || command === "delete"
    || command === "list-ledgers"
    || command === "rename-ledger"
    || command === "delete-ledger";
}

/**
 * @param {string[]} args
 * @returns {{ values: Map<string, string[]>, flags: Set<string> }}
 */
function parseOptions(args) {
  /** @type {Map<string, string[]>} */
  const values = new Map();
  /** @type {Set<string>} */
  const flags = new Set();

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }
    const key = token.slice(2);
    if (!key) {
      throw new Error("Option names must not be empty.");
    }
    const nextValue = args[index + 1];
    if (typeof nextValue === "string" && !nextValue.startsWith("--")) {
      const existing = values.get(key);
      if (existing) {
        existing.push(nextValue);
      } else {
        values.set(key, [nextValue]);
      }
      index += 1;
      continue;
    }
    flags.add(key);
  }

  return { values, flags };
}

/**
 * @param {{ values: Map<string, string[]>, flags: Set<string> }} options
 * @param {string} key
 * @returns {string | null}
 */
function readOptionalValue(options, key) {
  const values = options.values.get(key);
  if (!values || values.length === 0) {
    return null;
  }
  const [first] = values;
  return first.trim().length > 0 ? first : null;
}

/**
 * @param {{ values: Map<string, string[]>, flags: Set<string> }} options
 * @param {string} key
 * @returns {string}
 */
function requireValue(options, key) {
  const value = readOptionalValue(options, key);
  if (!value) {
    throw new Error(`--${key} is required.`);
  }
  return value;
}

/**
 * @param {{ values: Map<string, string[]>, flags: Set<string> }} options
 * @param {string} key
 * @returns {number}
 */
function requireIntegerValue(options, key) {
  const value = requireValue(options, key);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--${key} must be a positive integer.`);
  }
  return parsed;
}

/**
 * @param {{ values: Map<string, string[]>, flags: Set<string> }} options
 * @returns {import("@electric-sql/pglite").PGlite}
 */
function resolveDb(options) {
  const dbPath = readOptionalValue(options, "db-path");
  if (dbPath) {
    return getDb(dbPath);
  }

  const chatId = readOptionalValue(options, "chat-id");
  if (chatId) {
    return getActionDb(chatId, "track_purchases");
  }

  throw new Error("Provide either --db-path or --chat-id.");
}

/**
 * @param {string} inputPath
 * @returns {Promise<import("../capabilities/purchases/input.js").PurchaseRegistrationInput>}
 */
async function readRegistrationInputFile(inputPath) {
  const fileText = await readFile(inputPath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(fileText);
  } catch {
    throw new Error(`Could not parse JSON input file: ${inputPath}`);
  }
  return readPurchaseRegistrationInput(parsed);
}

/**
 * @param {CliCommand} command
 * @param {{ values: Map<string, string[]>, flags: Set<string> }} options
 * @param {import("@electric-sql/pglite").PGlite} db
 * @returns {Promise<{ text: string, exitCode: number }>}
 */
async function runCommand(command, options, db) {
  await ensurePurchasesSchema(db);

  if (command === "register") {
    const inputPath = requireValue(options, "input-file");
    const input = await readRegistrationInputFile(inputPath);
    const ledgerName = readOptionalValue(options, "ledger-name");
    const prepared = preparePurchaseRegistration({
      ...input,
      ...(ledgerName ? { ledgerName } : {}),
    });

    if (!options.flags.has("yes")) {
      return {
        text: `${formatPurchasePreview(prepared, prepared.ledgerName)}\n\nRe-run with --yes to save this purchase.`,
        exitCode: 2,
      };
    }

    const saved = await registerPreparedPurchase(db, prepared);
    return {
      text: formatRegisteredPurchaseResult(
        { purchaseId: saved.purchaseId, ledgerName: saved.ledger.name },
        prepared,
      ),
      exitCode: 0,
    };
  }

  if (command === "history") {
    return {
      text: formatPurchaseHistory(await getPurchaseHistory(db, { ledgerName: readOptionalValue(options, "ledger-name") ?? undefined })),
      exitCode: 0,
    };
  }

  if (command === "summary") {
    return {
      text: formatPurchaseSummary(await getPurchaseSummary(db, { ledgerName: readOptionalValue(options, "ledger-name") ?? undefined })),
      exitCode: 0,
    };
  }

  if (command === "delete") {
    const purchaseId = requireIntegerValue(options, "purchase-id");
    const deleted = await deletePurchaseById(db, purchaseId);
    return {
      text: deleted.found
        ? formatDeletedPurchaseResult(deleted.purchaseId, deleted.storeName || "?")
        : `No se encontro la compra con ID ${purchaseId}`,
      exitCode: 0,
    };
  }

  if (command === "list-ledgers") {
    return {
      text: formatLedgerList(await listPurchaseLedgers(db)),
      exitCode: 0,
    };
  }

  if (command === "rename-ledger") {
    const ledgerName = requireValue(options, "ledger-name");
    const newLedgerName = requireValue(options, "new-ledger-name");
    const renamed = await renamePurchaseLedger(db, ledgerName, newLedgerName);
    return {
      text: renamed.found && renamed.ledger
        ? formatRenamedLedgerResult(renamed.ledger.name)
        : `No se encontro el libro "${ledgerName}".`,
      exitCode: 0,
    };
  }

  const ledgerName = requireValue(options, "ledger-name");
  const deletion = await prepareLedgerDeletion(db, ledgerName);
  if (!deletion.found || deletion.ledgerId === null || deletion.ledgerName === null) {
    return { text: `No se encontro el libro "${ledgerName}".`, exitCode: 0 };
  }
  if (!options.flags.has("yes")) {
    return {
      text: `${formatDeleteLedgerPreview(deletion.ledgerName, deletion.purchaseCount)}\n\nRe-run with --yes to delete this ledger.`,
      exitCode: 2,
    };
  }
  await deleteLedgerById(db, deletion.ledgerId);
  return {
    text: formatDeletedLedgerResult(deletion.ledgerName, deletion.purchaseCount),
    exitCode: 0,
  };
}

/**
 * @param {string[]} argv
 * @returns {Promise<void>}
 */
async function main(argv) {
  const [command, ...rest] = argv;
  if (!isCliCommand(command)) {
    throw new Error(
      "Usage: track-purchases.js <register|history|summary|delete|list-ledgers|rename-ledger|delete-ledger> [options]",
    );
  }

  const options = parseOptions(rest);
  const db = resolveDb(options);
  try {
    const result = await runCommand(command, options, db);
    if (result.text) {
      console.log(result.text);
    }
    process.exitCode = result.exitCode;
  } finally {
    await db.close();
  }
}

main(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
