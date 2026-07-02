#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_URL = "https://private-host-redacted/";
const DEFAULT_AUDIO = "/tmp/hey-jarvis-smoke.wav";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const profileDir = await mkdtemp(join(tmpdir(), "web-wake-smoke-"));
  const port = await getFreePort();

  /** @type {import("node:child_process").ChildProcess | null} */
  let chromium = null;

  try {
    const chromiumArgs = [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${port}`,
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${options.audio}`,
      "about:blank",
    ];
    if (!options.headed) {
      chromiumArgs.unshift("--headless=new");
    }
    const activeChromium = spawn("chromium", chromiumArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    chromium = activeChromium;
    activeChromium.stderr?.on("data", () => {});

    await waitForDevtools(port);
    const page = await firstPage(port);
    const cdp = await connectCdp(page.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    if (options.stubRecognition) {
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: speechRecognitionStub(),
      });
    }

    await cdp.send("Page.navigate", { url: options.url });
    await waitForPageReady(cdp);
    await installFetchStub(cdp);
    const capability = await evaluate(cdp, `(() => ({
      secure: isSecureContext,
      hasMediaDevices: Boolean(navigator.mediaDevices?.getUserMedia),
      hasSpeechRecognition: Boolean(window.SpeechRecognition || window.webkitSpeechRecognition),
      wakeStatus: document.querySelector("#wake-status")?.textContent || "",
      detectorVersion: document.querySelector("#wake-detector-version")?.textContent || ""
    }))()`);

    await click(cdp, "#start-listening");
    const result = await waitForWakeDetection(cdp, options.timeoutMs, options.waitComplete);
    const report = {
      mode: options.stubRecognition ? "stub-recognition" : "native-web-speech",
      url: options.url,
      audio: options.audio,
      capability,
      ...result,
    };
    console.log(JSON.stringify(report, null, 2));
    if (options.waitComplete ? !result.completed : !result.detected) {
      process.exitCode = 1;
    }
    await cdp.close();
  } finally {
    chromium?.kill("SIGTERM");
    await cleanupProfile(profileDir);
  }
}

/**
 * @param {string} profileDir
 * @returns {Promise<void>}
 */
async function cleanupProfile(profileDir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(profileDir, { recursive: true, force: true });
      return;
    } catch {
      await delay(200);
    }
  }
}

/**
 * @param {string[]} argv
 * @returns {{ url: string, audio: string, timeoutMs: number, stubRecognition: boolean, headed: boolean, waitComplete: boolean }}
 */
function parseArgs(argv) {
  let url = DEFAULT_URL;
  let audio = DEFAULT_AUDIO;
  let timeoutMs = 15_000;
  let stubRecognition = false;
  let headed = false;
  let waitComplete = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--url" && next) {
      url = next;
      index += 1;
    } else if (arg === "--audio" && next) {
      audio = next;
      index += 1;
    } else if (arg === "--timeout-ms" && next) {
      timeoutMs = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === "--stub-recognition") {
      stubRecognition = true;
    } else if (arg === "--headed") {
      headed = true;
    } else if (arg === "--wait-complete") {
      waitComplete = true;
    }
  }
  return {
    url,
    audio,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 15_000,
    stubRecognition,
    headed,
    waitComplete,
  };
}

/**
 * @returns {Promise<number>}
 */
async function getFreePort() {
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = server.address();
  const portValue = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  return portValue;
}

/**
 * @param {number} port
 * @returns {Promise<void>}
 */
async function waitForDevtools(port) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        return;
      }
    } catch {
      await delay(100);
    }
  }
  throw new Error("Chromium DevTools endpoint did not start.");
}

/**
 * @param {number} port
 * @returns {Promise<{ webSocketDebuggerUrl: string }>}
 */
async function firstPage(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  const pages = /** @type {Array<{ type: string, webSocketDebuggerUrl?: string }>} */ (await response.json());
  const page = pages.find((candidate) => candidate.type === "page" && candidate.webSocketDebuggerUrl);
  if (!page?.webSocketDebuggerUrl) {
    throw new Error("No Chromium page target found.");
  }
  return { webSocketDebuggerUrl: page.webSocketDebuggerUrl };
}

class CdpClient {
  /** @type {number} */
  id = 0;
  /** @type {Map<number, { resolve: (value: unknown) => void, reject: (error: Error) => void }>} */
  callbacks = new Map();

  /**
   * @param {WebSocket} socket
   */
  constructor(socket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (typeof message.id !== "number") {
        return;
      }
      const callback = this.callbacks.get(message.id);
      if (!callback) {
        return;
      }
      this.callbacks.delete(message.id);
      if (message.error) {
        callback.reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        callback.resolve(message.result);
      }
    });
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @returns {Promise<unknown>}
   */
  send(method, params = {}) {
    const id = ++this.id;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.callbacks.set(id, { resolve, reject });
    });
  }

  /**
   * @returns {Promise<void>}
   */
  async close() {
    this.socket.close();
  }
}

/**
 * @param {string} url
 * @returns {Promise<CdpClient>}
 */
async function connectCdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(undefined), { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket connection failed.")), { once: true });
  });
  return new CdpClient(socket);
}

/**
 * @param {CdpClient} cdp
 * @returns {Promise<void>}
 */
async function waitForPageReady(cdp) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const ready = await evaluate(cdp, `document.readyState === "complete" && Boolean(document.querySelector("#start-listening"))`);
    if (ready === true) {
      return;
    }
    await delay(100);
  }
  throw new Error("Page did not become ready.");
}

/**
 * @param {CdpClient} cdp
 * @returns {Promise<void>}
 */
async function installFetchStub(cdp) {
  await cdp.send("Runtime.evaluate", {
    expression: `
      (() => {
        const realFetch = window.fetch.bind(window);
        window.fetch = (input, init) => {
          const url = String(input instanceof Request ? input.url : input);
          if (url.includes("/audio-turns")) {
            return Promise.resolve(new Response(JSON.stringify({
              status: "completed",
              text: "wake smoke recognized"
            }), { status: 200, headers: { "content-type": "application/json" } }));
          }
          return realFetch(input, init);
        };
      })()
    `,
  });
}

/**
 * @param {CdpClient} cdp
 * @param {string} selector
 * @returns {Promise<void>}
 */
async function click(cdp, selector) {
  await cdp.send("Runtime.evaluate", {
    expression: `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: "center", inline: "center" })`,
  });
  await delay(100);
  const rect = await evaluate(cdp, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error("Missing ${selector}");
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (!isPoint(rect)) {
    throw new Error(`Could not locate ${selector}.`);
  }
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", buttons: 1, clickCount: 1, x: rect.x, y: rect.y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", buttons: 0, clickCount: 1, x: rect.x, y: rect.y });
}

/**
 * @param {unknown} value
 * @returns {value is { x: number, y: number }}
 */
function isPoint(value) {
  return typeof value === "object" && value !== null
    && typeof /** @type {{ x?: unknown }} */ (value).x === "number"
    && typeof /** @type {{ y?: unknown }} */ (value).y === "number";
}

/**
 * @param {CdpClient} cdp
 * @param {number} timeoutMs
 * @param {boolean} waitComplete
 * @returns {Promise<{ detected: boolean, completed: boolean, wakeStatus: string, statusText: string, assistantText: string, diagnostics: string }>}
 */
async function waitForWakeDetection(cdp, timeoutMs, waitComplete) {
  const deadline = Date.now() + timeoutMs;
  let last = await readPageState(cdp);
  while (Date.now() < deadline) {
    last = await readPageState(cdp);
    if (waitComplete ? last.completed : last.detected) {
      return last;
    }
    await delay(250);
  }
  return last;
}

/**
 * @param {CdpClient} cdp
 * @returns {Promise<{ detected: boolean, completed: boolean, wakeStatus: string, statusText: string, assistantText: string, diagnostics: string }>}
 */
async function readPageState(cdp) {
  const state = await evaluate(cdp, `(() => {
    const wakeStatus = document.querySelector("#wake-status")?.textContent || "";
    const statusText = document.querySelector("#status-text")?.textContent || "";
    const assistantText = document.querySelector("#assistant-text")?.textContent || "";
    const diagnostics = document.querySelector("#diagnostics-output")?.textContent || "";
    const combined = wakeStatus + " " + statusText + " " + assistantText + " " + diagnostics;
    return {
      detected: /Wake phrase detected|Capturing command|wake smoke recognized/i.test(combined),
      completed: /wake smoke recognized|Assistant returned text but no audio/i.test(combined),
      wakeStatus,
      statusText,
      assistantText,
      diagnostics,
    };
  })()`);
  if (!isPageState(state)) {
    throw new Error("Unexpected page state shape.");
  }
  return state;
}

/**
 * @param {unknown} value
 * @returns {value is { detected: boolean, completed: boolean, wakeStatus: string, statusText: string, assistantText: string, diagnostics: string }}
 */
function isPageState(value) {
  return typeof value === "object" && value !== null
    && typeof /** @type {{ detected?: unknown }} */ (value).detected === "boolean"
    && typeof /** @type {{ completed?: unknown }} */ (value).completed === "boolean"
    && typeof /** @type {{ wakeStatus?: unknown }} */ (value).wakeStatus === "string"
    && typeof /** @type {{ statusText?: unknown }} */ (value).statusText === "string"
    && typeof /** @type {{ assistantText?: unknown }} */ (value).assistantText === "string"
    && typeof /** @type {{ diagnostics?: unknown }} */ (value).diagnostics === "string";
}

/**
 * @param {CdpClient} cdp
 * @param {string} expression
 * @returns {Promise<unknown>}
 */
async function evaluate(cdp, expression) {
  const result = /** @type {{ result?: { value?: unknown }, exceptionDetails?: unknown }} */ (await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }));
  if (result.exceptionDetails) {
    throw new Error(JSON.stringify(result.exceptionDetails));
  }
  return result.result?.value;
}

/**
 * @returns {string}
 */
function speechRecognitionStub() {
  return `
    (() => {
      class SmokeSpeechRecognition {
        constructor() {
          this.continuous = false;
          this.interimResults = false;
          this.lang = "en-US";
          this.maxAlternatives = 1;
          this.onresult = null;
          this.onerror = null;
          this.onend = null;
        }
        start() {
          setTimeout(() => {
            const alternative = { transcript: "hey jarvis", confidence: 0.99 };
            const result = { 0: alternative, length: 1, isFinal: true, item(index) { return this[index]; } };
            const results = { 0: result, length: 1, item(index) { return this[index]; } };
            this.onresult?.({ resultIndex: 0, results });
          }, 300);
        }
        stop() { this.onend?.(); }
        abort() { this.onend?.(); }
      }
      window.SpeechRecognition = SmokeSpeechRecognition;
      window.webkitSpeechRecognition = SmokeSpeechRecognition;
    })();
  `;
}

await main();
