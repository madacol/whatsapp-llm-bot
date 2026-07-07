process.env.TESTING = "1";

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
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
    assert.match(indexText, /Start Listening/);
    assert.match(indexText, /Wake threshold/);
    assert.match(indexText, /Local openWakeWord v13/);
    assert.match(indexText, /ort\.wasm\.min\.js/);
    assert.doesNotMatch(indexText, /Start Recording|Stop And Send|Manual capture|Record And Send/);
    assert.doesNotMatch(indexText, /Picovoice|Porcupine|AccessKey|Web Speech|SpeechRecognition/);

    const script = await fetch(`${baseUrl}/app.js`);
    assert.equal(script.status, 200);
    assert.equal(script.headers.get("content-type"), "text/javascript; charset=utf-8");
    const scriptText = await script.text();
    assert.match(scriptText, /audio-turns/);
    assert.match(scriptText, /OpenWakeWordJarvisDetector/);
    assert.match(scriptText, /Local openWakeWord v13/);
    assert.doesNotMatch(scriptText, /startRecording|stopAndSend|discardRecording/);
    assert.doesNotMatch(scriptText, /Picovoice|Porcupine|AccessKey|Web Speech|SpeechRecognition/);

    const openWakeWordModule = await fetch(`${baseUrl}/openwakeword.js`);
    assert.equal(openWakeWordModule.status, 200);
    assert.equal(openWakeWordModule.headers.get("content-type"), "text/javascript; charset=utf-8");
    await discardResponseBody(openWakeWordModule);

    const ortBundle = await fetch(`${baseUrl}/vendor/onnxruntime/ort.wasm.min.js`);
    assert.equal(ortBundle.status, 200);
    assert.equal(ortBundle.headers.get("content-type"), "text/javascript; charset=utf-8");
    await discardResponseBody(ortBundle);

    const ortWasm = await fetch(`${baseUrl}/vendor/onnxruntime/ort-wasm-simd-threaded.wasm`);
    assert.equal(ortWasm.status, 200);
    assert.equal(ortWasm.headers.get("content-type"), "application/wasm");
    await discardResponseBody(ortWasm);

    const ortWasmModule = await fetch(`${baseUrl}/vendor/onnxruntime/ort-wasm-simd-threaded.mjs`);
    assert.equal(ortWasmModule.status, 200);
    assert.equal(ortWasmModule.headers.get("content-type"), "text/javascript; charset=utf-8");
    await discardResponseBody(ortWasmModule);

    for (const modelPath of [
      "vendor/openwakeword/melspectrogram.onnx",
      "vendor/openwakeword/embedding_model.onnx",
      "vendor/openwakeword/hey_jarvis_v0.1.onnx",
    ]) {
      const model = await fetch(`${baseUrl}/${modelPath}`);
      assert.equal(model.status, 200);
      assert.equal(model.headers.get("content-type"), "application/octet-stream");
      await discardResponseBody(model);
    }
  });

  it("rejects missing files and path traversal", async () => {
    const server = createWebAudioClientServer();
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
    const baseUrl = `http://127.0.0.1:${listeningPort(server)}`;

    const missing = await fetch(`${baseUrl}/missing.js`);
    assert.equal(missing.status, 404);
    await discardResponseBody(missing);
    const traversal = await fetch(`${baseUrl}/%2e%2e/package.json`);
    assert.equal(traversal.status, 404);
    await discardResponseBody(traversal);
  });

  it("proxies same-origin API requests to the configured backend", async () => {
    let upstreamCalled = false;
    const upstream = createServer((req, res) => {
      upstreamCalled = true;
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/api/transports/voice/audio-turns?wait=true&token=share-token");
      assert.equal(req.headers["x-chat-id"], "api:web-1");

      /** @type {Buffer[]} */
      const chunks = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        assert.equal(Buffer.concat(chunks).toString("utf8"), "fake audio");
        res.writeHead(202, {
          "content-type": "application/json; charset=utf-8",
          "x-upstream": "http-api",
        });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    servers.push(upstream);
    await listen(upstream);

    const server = createWebAudioClientServer({
      apiTarget: `http://127.0.0.1:${listeningPort(upstream)}`,
    });
    servers.push(server);
    await listen(server);
    const baseUrl = `http://127.0.0.1:${listeningPort(server)}`;

    const response = await fetch(`${baseUrl}/api/transports/voice/audio-turns?wait=true&token=share-token`, {
      method: "POST",
      headers: {
        "content-type": "audio/ogg",
        "x-chat-id": "api:web-1",
      },
      body: "fake audio",
    });

    assert.equal(response.status, 202);
    assert.equal(response.headers.get("x-upstream"), "http-api");
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(upstreamCalled, true);
  });

  it("proxies the same-origin health check to the configured backend", async () => {
    const upstream = createServer((req, res) => {
      assert.equal(req.method, "GET");
      assert.equal(req.url, "/health?token=share-token");
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify({ ok: true }));
    });
    servers.push(upstream);
    await listen(upstream);

    const server = createWebAudioClientServer({
      apiTarget: `http://127.0.0.1:${listeningPort(upstream)}`,
    });
    servers.push(server);
    await listen(server);
    const baseUrl = `http://127.0.0.1:${listeningPort(server)}`;

    const response = await fetch(`${baseUrl}/health?token=share-token`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  });

  it("resolves content types and static paths defensively", () => {
    assert.equal(contentTypeForPath("index.html"), "text/html; charset=utf-8");
    assert.equal(contentTypeForPath("app.js"), "text/javascript; charset=utf-8");
    assert.equal(contentTypeForPath("runtime.mjs"), "text/javascript; charset=utf-8");
    assert.equal(contentTypeForPath("runtime.wasm"), "application/wasm");
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

/**
 * @param {import("node:http").Server} server
 * @returns {Promise<void>}
 */
function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
}

/**
 * @param {Response} response
 * @returns {Promise<void>}
 */
async function discardResponseBody(response) {
  await response.body?.cancel();
}
