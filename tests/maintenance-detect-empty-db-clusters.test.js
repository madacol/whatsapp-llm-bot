import { mkdtemp, mkdir, symlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectClusterRoots } from "../maintenance/detect-empty-db-clusters.js";

/** @type {string[]} */
const tempDirs = [];

/**
 * @returns {Promise<string>}
 */
async function makeTempDir() {
  const tempDir = await mkdtemp(path.join(tmpdir(), "db-cluster-roots-"));
  tempDirs.push(tempDir);
  return tempDir;
}

/**
 * @param {string} root
 * @returns {Promise<void>}
 */
async function makeClusterRoot(root) {
  await mkdir(path.join(root, "global"), { recursive: true });
  await mkdir(path.dirname(path.join(root, "PG_VERSION")), { recursive: true });
  await writeFile(path.join(root, "PG_VERSION"), "17\n");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true, force: true })));
});

describe("collectClusterRoots", () => {
  it("prefers canonical chat paths and still includes legacy-only clusters", async () => {
    const root = await makeTempDir();
    const chatDir = path.join(root, "chat");
    const legacyPgdataDir = path.join(root, "repo", "pgdata");
    const chatId = "123@g.us";
    const canonicalPgdata = path.join(chatDir, chatId, "pgdata");
    const legacyPgdata = path.join(legacyPgdataDir, chatId);
    const actionDb = path.join(chatDir, chatId, "actions", "create_action");
    const legacyOnly = path.join(legacyPgdataDir, "legacy-only");
    const rootDb = path.join(legacyPgdataDir, "root");

    await makeClusterRoot(legacyPgdata);
    await makeClusterRoot(actionDb);
    await makeClusterRoot(legacyOnly);
    await makeClusterRoot(rootDb);
    await mkdir(path.dirname(canonicalPgdata), { recursive: true });
    await symlink(legacyPgdata, canonicalPgdata, "dir");

    const roots = await collectClusterRoots({
      baseDir: null,
      chatDir,
      legacyPgdataDir,
      includeRoot: false,
    });

    assert.deepEqual(roots, [
      canonicalPgdata,
      actionDb,
      legacyOnly,
    ].sort((left, right) => left.localeCompare(right)));
  });
});
