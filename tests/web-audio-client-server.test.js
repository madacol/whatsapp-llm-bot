process.env.TESTING = "1";

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createWebAudioClientServer, contentTypeForPath, resolveStaticPath } from "../clients/web/server.js";

/** @type {import("node:http").Server[]} */
const servers = [];

after(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(() => resolve(undefined)))));
});

describe("web audio client static server", () => {
  it("serves the web client index and assets", async () => {
    const server = createWebAudioClientServer();
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
    const baseUrl = `http://127.0.0.1:${listeningPort(server)}`;

    const index = await fetch(`${baseUrl}/`);
    assert.equal(index.status, 200);
    assert.equal(index.headers.get("content-type"), "text/html; charset=utf-8");
    const indexText = await index.text();
    assert.match(indexText, /Web Audio Client/);
    assert.match(indexText, /Word detection/);
    assert.match(indexText, /Picovoice AccessKey/);
    assert.match(indexText, /Local Porcupine v10/);
    assert.match(indexText, /porcupine-web\.iife\.js/);

    const script = await fetch(`${baseUrl}/app.js`);
    assert.equal(script.status, 200);
    assert.equal(script.headers.get("content-type"), "text/javascript; charset=utf-8");
    const scriptText = await script.text();
    assert.match(scriptText, /audio-turns/);
    assert.match(scriptText, /Porcupine/);
    assert.match(scriptText, /Local Porcupine v10/);

    const porcupineBundle = await fetch(`${baseUrl}/vendor/picovoice/porcupine-web.iife.js`);
    assert.equal(porcupineBundle.status, 200);
    assert.equal(porcupineBundle.headers.get("content-type"), "text/javascript; charset=utf-8");

    const porcupineModel = await fetch(`${baseUrl}/vendor/porcupine/porcupine_params.pv`);
    assert.equal(porcupineModel.status, 200);
    assert.equal(porcupineModel.headers.get("content-type"), "application/octet-stream");
  });

  it("rejects missing files and path traversal", async () => {
    const server = createWebAudioClientServer();
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
    const baseUrl = `http://127.0.0.1:${listeningPort(server)}`;

    assert.equal((await fetch(`${baseUrl}/missing.js`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/%2e%2e/package.json`)).status, 404);
  });

  it("resolves content types and static paths defensively", () => {
    assert.equal(contentTypeForPath("index.html"), "text/html; charset=utf-8");
    assert.equal(contentTypeForPath("app.js"), "text/javascript; charset=utf-8");
    assert.equal(contentTypeForPath("voice.bin"), "application/octet-stream");

    assert.ok(resolveStaticPath("/tmp/client", "/index.html")?.endsWith("/tmp/client/index.html"));
    assert.equal(resolveStaticPath("/tmp/client", "/../package.json"), null);
  });
});

/**
 * @param {import("node:http").Server} server
 * @returns {number}
 */
function listeningPort(server) {
  const address = server.address();
  if (!address || typeof address !== "object") {
    throw new Error("Expected server to listen on an AddressInfo endpoint");
  }
  return address.port;
}
