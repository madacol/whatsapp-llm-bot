#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const url = buildTokenWebsiteUrl(options);
  const profileDir = await mkdtemp(join(tmpdir(), "web-token-smoke-"));
  const port = await getFreePort();

  /** @type {import("node:child_process").ChildProcess | null} */
  let chromium = null;
  let chromiumStderr = "";

  try {
    const chromiumArgs = [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      `--user-data-dir=${profileDir}`,
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${port}`,
      "about:blank",
    ];
    if (!options.headed) {
      chromiumArgs.unshift("--headless=new");
    }
    const activeChromium = spawn("chromium", chromiumArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    chromium = activeChromium;
    activeChromium.stderr?.on("data", (chunk) => {
      chromiumStderr = `${chromiumStderr}${String(chunk)}`.slice(-4000);
    });

    await waitForDevtools(port, () => chromiumStderr);
    const page = await firstPage(port);
    const cdp = await connectCdp(page.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    await cdp.send("Page.navigate", { url });
    await waitForPageReady(cdp, options.timeoutMs);

    const initial = await readTokenPageState(cdp);
    await clickElement(cdp, "#check-api");
    const health = await waitForHealthCheck(cdp, options.timeoutMs);
    const audioProbe = await probeAudioPreflight(cdp);
    const passed = health.passed
      && audioProbe.status === 400
      && /Expected non-empty audio request body/i.test(audioProbe.body);

    console.log(JSON.stringify({
      url: redactUrl(url),
      initial: redactPageState(initial),
      health,
      audioProbe: redactAudioProbe(audioProbe),
      passed,
    }, null, 2));
    if (!passed) {
      process.exitCode = 1;
    }
    await cdp.close();
  } finally {
    chromium?.kill("SIGTERM");
    await cleanupProfile(profileDir);
  }
}

/**
 * @param {string[]} argv
 * @returns {{ url: string, clientUrl: string, apiUrl: string, timeoutMs: number, headed: boolean }}
 */
function parseArgs(argv) {
  let url = process.env.WEB_AUDIO_TOKEN_URL || "";
  let clientUrl = process.env.WEB_AUDIO_CLIENT_URL || "";
  let apiUrl = process.env.WEB_AUDIO_API_URL || "";
  let timeoutMs = 20_000;
  let headed = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--url" && next) {
      url = next;
      index += 1;
    } else if (arg === "--client-url" && next) {
      clientUrl = next;
      index += 1;
    } else if (arg === "--api-url" && next) {
      apiUrl = next;
      index += 1;
    } else if (arg === "--timeout-ms" && next) {
      timeoutMs = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === "--headed") {
      headed = true;
    }
  }

  return {
    url,
    clientUrl,
    apiUrl,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 20_000,
    headed,
  };
}

/**
 * @param {{ url: string, clientUrl: string, apiUrl: string }} options
 * @returns {string}
 */
function buildTokenWebsiteUrl(options) {
  if (options.url) {
    return options.url;
  }
  if (!options.clientUrl || !options.apiUrl) {
    throw new Error("Set WEB_AUDIO_CLIENT_URL and WEB_AUDIO_API_URL, or pass --url.");
  }
  const url = new URL(options.clientUrl);
  url.searchParams.set("api", options.apiUrl);
  return url.toString();
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
 * @returns {Promise<number>}
 */
async function getFreePort() {
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(undefined);
    });
  });
  const address = server.address();
  const portValue = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  return portValue;
}

/**
 * @param {number} port
 * @param {() => string} [stderrSnapshot]
 * @returns {Promise<void>}
 */
async function waitForDevtools(port, stderrSnapshot = () => "") {
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
  const stderr = stderrSnapshot().trim();
  throw new Error(`Chromium DevTools endpoint did not start.${stderr ? `\nChromium stderr:\n${stderr}` : ""}`);
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
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
async function waitForPageReady(cdp, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await evaluate(cdp, `document.readyState === "complete" && Boolean(document.querySelector("#check-api"))`);
    if (ready === true) {
      return;
    }
    await delay(100);
  }
  throw new Error("Token web client did not become ready.");
}

/**
 * @param {CdpClient} cdp
 * @param {string} selector
 * @returns {Promise<void>}
 */
async function clickElement(cdp, selector) {
  await evaluate(cdp, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error("Missing ${selector}");
    element.click();
  })()`);
}

/**
 * @param {CdpClient} cdp
 * @param {number} timeoutMs
 * @returns {Promise<{ passed: boolean, statusText: string, diagnostics: string }>}
 */
async function waitForHealthCheck(cdp, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let state = await readTokenPageState(cdp);
  while (Date.now() < deadline) {
    state = await readTokenPageState(cdp);
    if (/API health check passed/i.test(state.statusText) && /"ok"\s*:\s*true/.test(state.diagnostics)) {
      return {
        passed: true,
        statusText: state.statusText,
        diagnostics: state.diagnostics,
      };
    }
    await delay(100);
  }
  return {
    passed: false,
    statusText: state.statusText,
    diagnostics: state.diagnostics,
  };
}

/**
 * @param {CdpClient} cdp
 * @returns {Promise<{ baseUrl: string, transportId: string, statusText: string, diagnostics: string }>}
 */
async function readTokenPageState(cdp) {
  const state = await evaluate(cdp, `(() => ({
    baseUrl: document.querySelector("#base-url")?.value || "",
    transportId: document.querySelector("#transport-id")?.value || "",
    statusText: document.querySelector("#status-text")?.textContent || "",
    diagnostics: document.querySelector("#diagnostics-output")?.textContent || ""
  }))()`);
  if (!isTokenPageState(state)) {
    throw new Error("Unexpected token page state shape.");
  }
  return state;
}

/**
 * @param {CdpClient} cdp
 * @returns {Promise<{ ok: boolean, status: number, body: string, url: string, error: string }>}
 */
async function probeAudioPreflight(cdp) {
  const result = await evaluate(cdp, `(async () => {
    const baseUrl = document.querySelector("#base-url")?.value || "";
    const transportId = document.querySelector("#transport-id")?.value || "voice";
    const url = new URL(baseUrl);
    const basePath = url.pathname.replace(/\\/+$/, "");
    url.pathname = basePath + "/api/transports/" + encodeURIComponent(transportId) + "/audio-turns";
    url.searchParams.set("wait", "true");
    try {
      const response = await fetch(url.toString(), {
        method: "POST",
        headers: {
          "content-type": "audio/webm",
          "x-request-id": "web-token-smoke-" + Date.now(),
          "x-chat-id": "api:web-token-smoke",
          "x-sender-id": "web-token-smoke",
          "x-sender-name": "Web Token Smoke",
          "x-timestamp": new Date().toISOString()
        },
        // Empty audio should reach the authenticated API and fail as a 400,
        // not fail as a browser CORS/network error.
        body: new Blob([], { type: "audio/webm" })
      });
      return {
        ok: response.ok,
        status: response.status,
        body: (await response.text()).slice(0, 500),
        url: url.toString(),
        error: ""
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        body: "",
        url: url.toString(),
        error: error instanceof Error ? error.message : String(error)
      };
    }
  })()`);
  if (!isAudioProbeResult(result)) {
    throw new Error("Unexpected audio preflight probe result shape.");
  }
  return result;
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
 * @param {unknown} value
 * @returns {value is { baseUrl: string, transportId: string, statusText: string, diagnostics: string }}
 */
function isTokenPageState(value) {
  return typeof value === "object" && value !== null
    && typeof /** @type {{ baseUrl?: unknown }} */ (value).baseUrl === "string"
    && typeof /** @type {{ transportId?: unknown }} */ (value).transportId === "string"
    && typeof /** @type {{ statusText?: unknown }} */ (value).statusText === "string"
    && typeof /** @type {{ diagnostics?: unknown }} */ (value).diagnostics === "string";
}

/**
 * @param {unknown} value
 * @returns {value is { ok: boolean, status: number, body: string, url: string, error: string }}
 */
function isAudioProbeResult(value) {
  return typeof value === "object" && value !== null
    && typeof /** @type {{ ok?: unknown }} */ (value).ok === "boolean"
    && typeof /** @type {{ status?: unknown }} */ (value).status === "number"
    && typeof /** @type {{ body?: unknown }} */ (value).body === "string"
    && typeof /** @type {{ url?: unknown }} */ (value).url === "string"
    && typeof /** @type {{ error?: unknown }} */ (value).error === "string";
}

/**
 * @param {string} value
 * @returns {string}
 */
function redactUrl(value) {
  try {
    const url = new URL(value);
    if (url.searchParams.has("token")) {
      url.searchParams.set("token", "<redacted>");
    }
    const apiUrl = url.searchParams.get("api");
    if (apiUrl) {
      url.searchParams.set("api", redactUrl(apiUrl));
    }
    return url.toString();
  } catch {
    return value;
  }
}

/**
 * @param {{ baseUrl: string, transportId: string, statusText: string, diagnostics: string }} state
 * @returns {{ baseUrl: string, transportId: string, statusText: string, diagnostics: string }}
 */
function redactPageState(state) {
  return {
    ...state,
    baseUrl: redactUrl(state.baseUrl),
  };
}

/**
 * @param {{ ok: boolean, status: number, body: string, url: string, error: string }} probe
 * @returns {{ ok: boolean, status: number, body: string, url: string, error: string }}
 */
function redactAudioProbe(probe) {
  return {
    ...probe,
    url: redactUrl(probe.url),
  };
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
