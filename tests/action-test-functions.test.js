import { describe, it, before } from "node:test";
import fs from "fs/promises";
import path from "path";
import { createTestDb } from "./helpers.js";

/** @type {Array<{name: string, action_fn: Function, test_functions: Function[]}>} */
let entries = [];
/** @type {import("@electric-sql/pglite").PGlite} */
let db;

before(async () => {
  db = await createTestDb();
  const actionsDir = path.resolve(process.cwd(), "actions");
  const files = (await fs.readdir(actionsDir, { recursive: true }))
    .filter((f) => f === "_tests.js" || f.endsWith("/_tests.js"));
  for (const file of files) {
    const testsPath = path.join(actionsDir, file);
    const indexPath = path.join(path.dirname(testsPath), "index.js");
    const [testsMod, actionMod] = await Promise.all([
      import(`file://${testsPath}`),
      import(`file://${indexPath}`),
    ]);
    entries.push({
      name: actionMod.default.name,
      action_fn: actionMod.default.action_fn,
      test_functions: testsMod.default,
    });
  }
});

describe("action test_functions", () => {
  it("runs all test_functions for every action", async (t) => {
    for (const { name, action_fn, test_functions } of entries) {
      await t.test(name, async (t2) => {
        for (const fn of test_functions) {
          await t2.test(fn.name || "anonymous test", async () => {
            await fn(action_fn, db);
          });
        }
      });
    }
  });
});
