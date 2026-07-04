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
    assert.match(indexText, /Wake threshold/);
    assert.match(indexText, /Local openWakeWord v13/);
    assert.match(indexText, /ort\.wasm\.min\.js/);
    assert.doesNotMatch(indexText, /Picovoice|Porcupine|AccessKey|Web Speech|SpeechRecognition/);

    const script = await fetch(`${baseUrl}/app.js`);
    assert.equal(script.status, 200);
    assert.equal(script.headers.get("content-type"), "text/javascript; charset=utf-8");
    const scriptText = await script.text();
    assert.match(scriptText, /audio-turns/);
    assert.match(scriptText, /OpenWakeWordJarvisDetector/);
    assert.match(scriptText, /Local openWakeWord v13/);
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
 * @param {Response} response
 * @returns {Promise<void>}
 */
async function discardResponseBody(response) {
  await response.body?.cancel();
}
