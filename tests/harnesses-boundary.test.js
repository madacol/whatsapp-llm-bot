import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(TEST_DIR, "..");

/** @type {Set<string>} */
const EXCLUDED_DIRS = new Set([
  ".git",
  ".claude",
  ".harnesses",
  ".madabot",
  "auth_info_baileys",
  "data",
  "node_modules",
  "patches",
  "pgdata",
  "tests",
]);

const STATIC_IMPORT_RE = /(?:import|export)\s+(?:[^"'()]+\s+from\s+)?["']([^"']+)["']/g;
const DYNAMIC_IMPORT_RE = /import\s*\(\s*["']([^"']+)["']\s*\)/g;

describe("Harnesses boundary", () => {
  it("keeps harness internals private outside the subsystem and tests", async () => {
    const sourceFiles = await collectSourceFiles(PROJECT_ROOT);
    /** @type {string[]} */
    const violations = [];

    for (const filePath of sourceFiles) {
      const importerPath = path.relative(PROJECT_ROOT, filePath).split(path.sep).join("/");
      const source = await readFile(filePath, "utf8");
      const specifiers = extractModuleSpecifiers(source);

      for (const specifier of specifiers) {
        const violation = classifyViolation(importerPath, specifier);
        if (violation) {
          violations.push(violation);
        }
      }
    }

    assert.deepEqual(violations, []);
  });
});

/**
 * @param {string} rootDir
 * @returns {Promise<string[]>}
 */
async function collectSourceFiles(rootDir) {
  /** @type {string[]} */
  const files = [];
  await walk(rootDir, files);
  return files;
}

/**
 * @param {string} dirPath
 * @param {string[]} files
 * @returns {Promise<void>}
 */
async function walk(dirPath, files) {
  const entries = await readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) {
        await walk(entryPath, files);
      }
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(entryPath);
    }
  }
}

/**
 * @param {string} source
 * @returns {string[]}
 */
function extractModuleSpecifiers(source) {
  /** @type {string[]} */
  const specifiers = [];

  for (const match of source.matchAll(STATIC_IMPORT_RE)) {
    const specifier = match[1];
    if (specifier) {
      specifiers.push(specifier);
    }
  }

  for (const match of source.matchAll(DYNAMIC_IMPORT_RE)) {
    const specifier = match[1];
    if (specifier) {
      specifiers.push(specifier);
    }
  }

  return specifiers;
}

/**
 * @param {string} importerPath
 * @param {string} specifier
 * @returns {string | null}
 */
function classifyViolation(importerPath, specifier) {
  if (importerPath.startsWith("harnesses/")) {
    return null;
  }

  if (specifier === "#harnesses") {
    return null;
  }

  if (specifier.startsWith("#harnesses/")) {
    return `${importerPath}: forbidden internal alias import ${specifier}`;
  }

  if (!specifier.startsWith(".")) {
    return null;
  }

  const resolvedPath = path.posix.normalize(
    path.posix.join(path.posix.dirname(importerPath), specifier),
  );

  if (!resolvedPath.startsWith("harnesses/")) {
    return null;
  }

  return `${importerPath}: forbidden harness internal import ${specifier}`;
}
