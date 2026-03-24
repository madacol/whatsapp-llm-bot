process.env.TESTING = "1";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { PGlite as PGliteDriver } from "@electric-sql/pglite";
import { storePage } from "../html-store.js";
import { startHtmlServer, stopHtmlServer } from "../html-server.js";

describe("html-server", () => {
  /** @type {PGlite} */
  let db;
  /** @type {number} */
  let assignedPort;

  before(async () => {
    db = new PGliteDriver("memory://");
    assignedPort = await startHtmlServer(0, db);
  });

  after(async () => {
    await stopHtmlServer();
    await db.close();
  });

  it("serves stored HTML at GET /page/:id (200)", async () => {
    const id = await storePage(db, "<h1>Test</h1>", "Test Page");
    const res = await fetch(`http://127.0.0.1:${assignedPort}/page/${id}`);

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
    const body = await res.text();
    assert.ok(body.includes("<h1>Test</h1>"));
    assert.ok(body.includes("<title>Test Page</title>"));
  });

  it("returns 404 for unknown ID", async () => {
    const res = await fetch(`http://127.0.0.1:${assignedPort}/page/00000000-0000-0000-0000-000000000000`);
    assert.equal(res.status, 404);
  });

  it("returns 404 for non-page routes", async () => {
    const res = await fetch(`http://127.0.0.1:${assignedPort}/other`);
    assert.equal(res.status, 404);
  });

  it("stopHtmlServer closes cleanly", async () => {
    await stopHtmlServer();
    // Starting again should work fine
    assignedPort = await startHtmlServer(0, db);
    const id = await storePage(db, "<p>After restart</p>");
    const res = await fetch(`http://127.0.0.1:${assignedPort}/page/${id}`);
    assert.equal(res.status, 200);
  });
});
