process.env.TESTING = "1";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { storePage } from "../html-store.js";
import { startHtmlServer, stopHtmlServer } from "../html-server.js";

describe("html-server", () => {
  /** @type {number} */
  let assignedPort;
  const chatId = "html-server-test";

  before(async () => {
    assignedPort = await startHtmlServer(0);
  });

  after(async () => {
    await stopHtmlServer();
  });

  it("serves stored HTML at GET /chat/:chatId/html/:id.html (200)", async () => {
    const hash = await storePage(chatId, "<h1>Test</h1>", "Test Page");
    const res = await fetch(`http://127.0.0.1:${assignedPort}/chat/${encodeURIComponent(chatId)}/html/${hash}.html`);

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
    const body = await res.text();
    assert.ok(body.includes("<h1>Test</h1>"));
    assert.ok(body.includes("<title>Test Page</title>"));
  });

  it("returns 404 for unknown ID", async () => {
    const res = await fetch(`http://127.0.0.1:${assignedPort}/chat/${encodeURIComponent(chatId)}/html/${"0".repeat(64)}.html`);
    assert.equal(res.status, 404);
  });

  it("returns 404 for non-page routes", async () => {
    const res = await fetch(`http://127.0.0.1:${assignedPort}/other`);
    assert.equal(res.status, 404);
  });

  it("stopHtmlServer closes cleanly", async () => {
    await stopHtmlServer();
    // Starting again should work fine
    assignedPort = await startHtmlServer(0);
    const hash = await storePage(chatId, "<p>After restart</p>");
    const res = await fetch(`http://127.0.0.1:${assignedPort}/chat/${encodeURIComponent(chatId)}/html/${hash}.html`);
    assert.equal(res.status, 200);
  });
});
