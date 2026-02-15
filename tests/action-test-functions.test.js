import { describe, it, before, after } from "node:test";
import fs from "fs/promises";
import path from "path";
import { PGlite } from "@electric-sql/pglite";
import { createTestDb } from "./helpers.js";

/** @type {Array<{fileName: string, action: Action}>} */
let actions = [];
/** @type {PGlite} */
let db;

before(async () => {
  db = await createTestDb();
  const actionsDir = path.resolve(process.cwd(), "actions");
  const files = (await fs.readdir(actionsDir)).filter((f) => f.endsWith(".js"));
  for (const file of files) {
    const mod = await import(`file://${path.join(actionsDir, file)}`);
    actions.push({ fileName: file, action: mod.default });
  }
});

after(async () => {
  await db.close();
});

describe("action test_functions", () => {
  it("runs all test_functions for every action", async (t) => {
    for (const { action } of actions) {
      await t.test(action.name, async (t2) => {
        for (const fn of action.test_functions) {
          await t2.test(fn.name || "anonymous test", async () => {
            await fn(action.action_fn, db);
          });
        }
      });
    }
  });
});
