#!/usr/bin/env node

import { PGlite } from "@electric-sql/pglite";
import { access, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

/**
 * @typedef EmptyDbReport
 * @property {"empty"} kind
 * @property {string} root
 * @property {number} size
 * @property {string[]} tables
 */

/**
 * @typedef NonEmptyDbReport
 * @property {"non-empty"} kind
 * @property {string} root
 * @property {string[]} nonEmptyTables
 */

/**
 * @typedef ErrorDbReport
 * @property {"error"} kind
 * @property {string} root
 * @property {string} message
 */

/** @typedef {EmptyDbReport | NonEmptyDbReport | ErrorDbReport} ClusterReport */

/**
 * @typedef ScanOptions
 * @property {string} baseDir
 * @property {boolean} includeRoot
 * @property {boolean} help
 * @property {boolean} json
 * @property {boolean} pathsOnly
 * @property {boolean} progress
 */

/**
 * @param {string} targetPath
 * @returns {string}
 */
function toDisplayPath(targetPath) {
  const relativePath = path.relative(process.cwd(), targetPath);
  return relativePath === "" ? "." : relativePath;
}

function printHelp() {
  console.log(`Usage: node maintenance/detect-empty-db-clusters.js [options]

Scan PGlite/Postgres cluster roots under pgdata/ and classify them as empty,
non-empty, or errored.

Options:
  --base-dir <path>   Base directory to scan. Default: pgdata
  --include-root      Include pgdata/root in the scan
  --paths-only        Print only empty DB cluster paths
  --json              Print the full result as JSON
  --progress          Print CHECKING lines to stderr while scanning
  --help              Show this help text

Examples:
  node maintenance/detect-empty-db-clusters.js
  node maintenance/detect-empty-db-clusters.js --progress
  node maintenance/detect-empty-db-clusters.js --paths-only
  node maintenance/detect-empty-db-clusters.js --json
`);
}

/**
 * @returns {ScanOptions}
 */
function parseCliArgs() {
  const parsed = parseArgs({
    allowPositionals: false,
    options: {
      "base-dir": {
        type: "string",
        default: "pgdata",
      },
      "include-root": {
        type: "boolean",
        default: false,
      },
      help: {
        type: "boolean",
        default: false,
      },
      json: {
        type: "boolean",
        default: false,
      },
      "paths-only": {
        type: "boolean",
        default: false,
      },
      progress: {
        type: "boolean",
        default: false,
      },
    },
  });

  const baseDir = parsed.values["base-dir"];
  const includeRoot = parsed.values["include-root"];
  const help = parsed.values.help;
  const json = parsed.values.json;
  const pathsOnly = parsed.values["paths-only"];
  const progress = parsed.values.progress;

  if (json && pathsOnly) {
    throw new Error("Choose either --json or --paths-only, not both.");
  }

  return {
    baseDir: path.resolve(process.cwd(), baseDir),
    includeRoot,
    help,
    json,
    pathsOnly,
    progress,
  };
}

/**
 * @param {string} baseDir
 * @returns {Promise<string[]>}
 */
async function findClusterRoots(baseDir) {
  await access(baseDir);

  /** @type {string[]} */
  const roots = [];
  /** @type {string[]} */
  const stack = [baseDir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    const entries = await readdir(current, { withFileTypes: true });
    const entryNames = new Set(entries.map((entry) => entry.name));

    if (entryNames.has("PG_VERSION") && entryNames.has("global")) {
      roots.push(current);
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      stack.push(path.join(current, entry.name));
    }
  }

  roots.sort((left, right) => left.localeCompare(right));
  return roots;
}

/**
 * @param {string} dir
 * @returns {Promise<number>}
 */
async function dirSize(dir) {
  let total = 0;
  /** @type {string[]} */
  const stack = [dir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const stats = await stat(fullPath);
      total += stats.size;
    }
  }

  return total;
}

/**
 * @param {string} root
 * @returns {Promise<ClusterReport>}
 */
async function classifyClusterRoot(root) {
  /** @type {PGlite | null} */
  let db = null;

  try {
    db = new PGlite(root);
    const result = await db.query(`
      SELECT n.nspname AS schema_name, c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r'
        AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      ORDER BY n.nspname, c.relname
    `);

    /** @type {string[]} */
    const allTables = [];
    /** @type {string[]} */
    const nonEmptyTables = [];

    for (const row of result.rows) {
      const schemaName = String(row.schema_name);
      const tableName = String(row.table_name);
      allTables.push(`${schemaName}.${tableName}`);

      const countResult = await db.query(
        `SELECT count(*)::int AS count FROM "${schemaName}"."${tableName}"`,
      );
      const rawCount = countResult.rows[0]?.count;
      const count = typeof rawCount === "number"
        ? rawCount
        : Number(rawCount ?? 0);

      if (count > 0) {
        nonEmptyTables.push(`${schemaName}.${tableName}:${count}`);
      }
    }

    if (nonEmptyTables.length === 0) {
      return {
        kind: "empty",
        root,
        size: await dirSize(root),
        tables: allTables,
      };
    }

    return {
      kind: "non-empty",
      root,
      nonEmptyTables,
    };
  } catch (error) {
    return {
      kind: "error",
      root,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (db) {
      try {
        await db.close();
      } catch {
        // ignore cleanup failures in maintenance scans
      }
    }
  }
}

/**
 * @param {ScanOptions} options
 * @returns {Promise<{
 *   scannedRoots: string[],
 *   empty: EmptyDbReport[],
 *   nonEmpty: NonEmptyDbReport[],
 *   errors: ErrorDbReport[],
 *   reclaimableBytes: number,
 * }>}
 */
async function scanClusters(options) {
  const rootClusters = await findClusterRoots(options.baseDir);
  const rootDbPath = path.join(options.baseDir, "root");
  const scannedRoots = options.includeRoot
    ? rootClusters
    : rootClusters.filter((root) => root !== rootDbPath);

  /** @type {EmptyDbReport[]} */
  const empty = [];
  /** @type {NonEmptyDbReport[]} */
  const nonEmpty = [];
  /** @type {ErrorDbReport[]} */
  const errors = [];

  for (const root of scannedRoots) {
    if (options.progress) {
      console.error(`CHECKING\t${toDisplayPath(root)}`);
    }

    const report = await classifyClusterRoot(root);
    if (report.kind === "empty") {
      empty.push(report);
      continue;
    }
    if (report.kind === "non-empty") {
      nonEmpty.push(report);
      continue;
    }
    errors.push(report);
  }

  let reclaimableBytes = 0;
  for (const report of empty) {
    reclaimableBytes += report.size;
  }

  return {
    scannedRoots,
    empty,
    nonEmpty,
    errors,
    reclaimableBytes,
  };
}

/**
 * @param {Awaited<ReturnType<typeof scanClusters>>} summary
 */
function printTextSummary(summary) {
  console.log(`SCANNED_DB_COUNT=${summary.scannedRoots.length}`);
  console.log(`EMPTY_DB_COUNT=${summary.empty.length}`);
  console.log(`NONEMPTY_DB_COUNT=${summary.nonEmpty.length}`);
  console.log(`ERRORED_DB_COUNT=${summary.errors.length}`);
  console.log(`RECLAIMABLE_BYTES=${summary.reclaimableBytes}`);

  for (const report of summary.empty) {
    console.log(
      `DELETE\t${report.size}\t${toDisplayPath(report.root)}\t${report.tables.join(",")}`,
    );
  }

  for (const report of summary.nonEmpty) {
    console.log(
      `KEEP\t${toDisplayPath(report.root)}\t${report.nonEmptyTables.join(",")}`,
    );
  }

  for (const report of summary.errors) {
    console.log(`ERROR\t${toDisplayPath(report.root)}\t${report.message}`);
  }
}

/**
 * @param {Awaited<ReturnType<typeof scanClusters>>} summary
 */
function printJsonSummary(summary) {
  console.log(JSON.stringify({
    scannedDbCount: summary.scannedRoots.length,
    emptyDbCount: summary.empty.length,
    nonEmptyDbCount: summary.nonEmpty.length,
    erroredDbCount: summary.errors.length,
    reclaimableBytes: summary.reclaimableBytes,
    empty: summary.empty.map((report) => ({
      root: toDisplayPath(report.root),
      size: report.size,
      tables: report.tables,
    })),
    nonEmpty: summary.nonEmpty.map((report) => ({
      root: toDisplayPath(report.root),
      nonEmptyTables: report.nonEmptyTables,
    })),
    errors: summary.errors.map((report) => ({
      root: toDisplayPath(report.root),
      message: report.message,
    })),
  }, null, 2));
}

/**
 * @returns {Promise<void>}
 */
async function main() {
  const options = parseCliArgs();

  if (options.help) {
    printHelp();
    return;
  }

  const summary = await scanClusters(options);

  if (options.pathsOnly) {
    for (const report of summary.empty) {
      console.log(toDisplayPath(report.root));
    }
    if (summary.errors.length > 0) {
      console.error(`Skipped ${summary.errors.length} errored DB cluster(s).`);
    }
    return;
  }

  if (options.json) {
    printJsonSummary(summary);
    return;
  }

  printTextSummary(summary);
}

await main();
