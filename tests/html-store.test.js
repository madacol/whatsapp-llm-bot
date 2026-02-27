process.env.TESTING = "1";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { storePage, getPage } from "../html-store.js";

/** @type {PGlite} */
let db;

before(async () => {
  db = new PGlite("memory://");
});

after(async () => {
  await db.close();
});

describe("html-store", () => {
  it("storePage returns a UUID and getPage retrieves it", async () => {
    const id = await storePage(db, "<h1>Hello</h1>", "Test Page");
    assert.match(id, /^[0-9a-f-]{36}$/);

    const page = await getPage(db, id);
    assert.ok(page);
    assert.equal(page.html, "<h1>Hello</h1>");
    assert.equal(page.title, "Test Page");
  });

  it("getPage returns null for unknown ID", async () => {
    const page = await getPage(db, "00000000-0000-0000-0000-000000000000");
    assert.equal(page, null);
  });

  it("pages persist (store, retrieve, verify match)", async () => {
    const html1 = "<p>Page 1</p>";
    const html2 = "<p>Page 2</p>";
    const id1 = await storePage(db, html1);
    const id2 = await storePage(db, html2, "Second");

    const page1 = await getPage(db, id1);
    const page2 = await getPage(db, id2);

    assert.ok(page1);
    assert.equal(page1.html, html1);
    assert.equal(page1.title, undefined);

    assert.ok(page2);
    assert.equal(page2.html, html2);
    assert.equal(page2.title, "Second");
  });
});
