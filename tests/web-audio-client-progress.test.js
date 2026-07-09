import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { parseHTML } from "linkedom";

const SETTINGS_KEY = "madabot.webAudioClient.settings.v1";

/**
 * @typedef {{
 *   document: Document,
 *   eventSources: MockEventSource[],
 *   fetchCalls: { url: string, method: string }[],
 *   commandTurns: unknown[],
 *   playCalls: string[],
 *   resolvePost: (() => void) | null,
 *   submitAudio: (blob: Blob) => Promise<{ assistantAudioStarted: boolean }>,
 *   cancelActiveTurn: () => Promise<void>,
 *   clearMessageHistory: () => Promise<void>,
 *   postSettled: () => boolean,
 * }} WebClientHarness
 */

class MockMediaRecorder {
  /**
   * @returns {boolean}
   */
  static isTypeSupported() {
    return true;
  }
}

class MockAudioContext {}

class MockEventSource {
  /** @type {MockEventSource[]} */
  static instances = [];

  /**
   * @param {string} url
   */
  constructor(url) {
    this.url = url;
    /** @type {((event: { data: string }) => void) | null} */
    this.onmessage = null;
    /** @type {(() => void) | null} */
    this.onerror = null;
    this.closed = false;
    MockEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  /**
   * @param {unknown} row
   */
  emit(row) {
    this.onmessage?.({ data: JSON.stringify(row) });
  }
}

/**
 * @param {() => void | Promise<void>} assertion
 * @param {number} [timeoutMs]
 * @returns {Promise<void>}
 */
async function waitFor(assertion, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  /** @type {unknown} */
  let lastError;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  await assertion();
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * @returns {Storage}
 */
function createLocalStorage() {
  /** @type {Map<string, string>} */
  const storage = new Map();
  return {
    /**
     * @param {string} key
     * @returns {string | null}
     */
    getItem(key) {
      return storage.has(key) ? storage.get(key) ?? null : null;
    },
    /**
     * @param {string} key
     * @param {string} value
     * @returns {void}
     */
    setItem(key, value) {
      storage.set(key, String(value));
    },
    /**
     * @param {string} key
     * @returns {void}
     */
    removeItem(key) {
      storage.delete(key);
    },
    /**
     * @returns {void}
     */
    clear() {
      storage.clear();
    },
    /**
     * @param {number} index
     * @returns {string | null}
     */
    key(index) {
      return Array.from(storage.keys())[index] ?? null;
    },
    get length() {
      return storage.size;
    },
  };
}

/**
 * @param {unknown} prototype
 * @param {string} property
 * @param {unknown} value
 */
function definePrototypeProperty(prototype, property, value) {
  Object.defineProperty(prototype, property, {
    configurable: true,
    writable: true,
    value,
  });
}

/**
 * @returns {WebClientHarness}
 */
function createWebClientHarness() {
  MockEventSource.instances = [];
  const html = readFileSync("clients/web/index.html", "utf8");
  const { document, window } = parseHTML(html);
  const localStorage = createLocalStorage();
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({
    baseUrl: "http://api.test",
    transportId: "voice",
    chatId: "api:web-progress",
    senderId: "web-user",
    senderName: "Web",
    wakePhrase: "jarvis",
    wakeThreshold: 0.5,
    wakeCaptureSeconds: 120,
    wakeSilenceSeconds: 1.5,
  }));

  /** @type {{ url: string, method: string }[]} */
  const fetchCalls = [];
  /** @type {unknown[]} */
  const commandTurns = [];
  /** @type {string[]} */
  const playCalls = [];
  /** @type {(() => void) | null} */
  let resolvePost = null;
  let postSettled = false;

  /**
   * @param {string | URL | Request} input
   * @param {RequestInit} [options]
   * @returns {Promise<Response>}
   */
  async function fetchMock(input, options = {}) {
    const url = String(input);
    const method = options.method ?? "GET";
    fetchCalls.push({ url, method });
    if (url.includes("/events") && !url.includes("/events/stream")) {
      return new Response(JSON.stringify({ events: [], nextEventId: "0" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/audio-turns")) {
      return await new Promise((resolve) => {
        resolvePost = () => {
          postSettled = true;
          resolve(new Response(JSON.stringify({
            requestId: "web-progress-request",
            status: "completed",
            text: "Final body text.",
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }));
        };
      });
    }
    if (url.includes("/turns")) {
      commandTurns.push(JSON.parse(String(options.body ?? "{}")));
      return new Response(JSON.stringify({
        requestId: "command-request",
        status: "completed",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/api/media/")) {
      return new Response(new Blob(["fake mp3"], { type: "audio/mpeg" }), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      });
    }
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  /**
   * @this {HTMLElement & { src?: string, dispatchEvent: (event: Event) => boolean }}
   * @returns {Promise<void>}
   */
  function playAudioElement() {
    const audio = /** @type {HTMLElement & { src?: string, dispatchEvent: (event: Event) => boolean }} */ (this);
    playCalls.push(audio.src ?? "");
    setTimeout(() => {
      audio.dispatchEvent(new window.Event("ended"));
    }, 0);
    return Promise.resolve();
  }
  definePrototypeProperty(window.HTMLElement.prototype, "play", playAudioElement);

  Object.defineProperty(window, "localStorage", { configurable: true, value: localStorage });
  Object.defineProperty(window.navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async () => ({
        getAudioTracks: () => [],
        getTracks: () => [],
      }),
    },
  });
  Object.assign(window, {
    fetch: fetchMock,
    EventSource: MockEventSource,
    MediaRecorder: MockMediaRecorder,
    AudioContext: MockAudioContext,
    ort: {},
  });

  class TestURL extends URL {}
  TestURL.createObjectURL = () => `blob:assistant-audio-${playCalls.length + 1}`;
  TestURL.revokeObjectURL = () => undefined;

  const context = vm.createContext({
    window,
    document,
    navigator: window.navigator,
    localStorage,
    location: new URL("http://localhost/web-audio/"),
    URL: TestURL,
    URLSearchParams,
    Blob,
    Response,
    fetch: fetchMock,
    EventSource: MockEventSource,
    MediaRecorder: MockMediaRecorder,
    AudioContext: MockAudioContext,
    WebAssembly,
    performance,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (/** @type {(timestamp: number) => void} */ callback) => setTimeout(() => callback(performance.now()), 0),
    cancelAnimationFrame: clearTimeout,
    isSecureContext: true,
    console,
    Event: window.Event,
    HTMLElement: window.HTMLElement,
    HTMLFormElement: window.HTMLElement,
    HTMLInputElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLElement,
    HTMLSpanElement: window.HTMLElement,
    HTMLAudioElement: window.HTMLElement,
    HTMLPreElement: window.HTMLElement,
  });
  context.globalThis = context;

  let source = readFileSync("clients/web/app.js", "utf8");
  source = source.replace(
    "import { OpenWakeWordJarvisDetector, OPEN_WAKE_WORD_MODEL_BASE_PATH } from \"./openwakeword.js\";\n",
    "class OpenWakeWordJarvisDetector {}\nconst OPEN_WAKE_WORD_MODEL_BASE_PATH = \"\";\n",
  );
  source += "\nwindow.__webClientTestHooks = { submitAudio, cancelActiveTurn, clearMessageHistory };\n";
  vm.runInContext(source, context, { filename: "clients/web/app.js" });
  const hooks = /** @type {Window & { __webClientTestHooks: Pick<WebClientHarness, "submitAudio" | "cancelActiveTurn" | "clearMessageHistory"> }} */ (
    /** @type {unknown} */ (window)
  ).__webClientTestHooks;

  return {
    document,
    eventSources: MockEventSource.instances,
    fetchCalls,
    commandTurns,
    playCalls,
    get resolvePost() {
      return resolvePost;
    },
    submitAudio: hooks.submitAudio,
    cancelActiveTurn: hooks.cancelActiveTurn,
    clearMessageHistory: hooks.clearMessageHistory,
    postSettled: () => postSettled,
  };
}

/**
 * @param {string} eventId
 * @param {unknown} content
 * @returns {unknown}
 */
function assistantOutputRow(eventId, content) {
  return {
    eventId,
    turnId: "turn-1",
    chatId: "api:web-progress",
    kind: "assistant_output",
    event: {
      kind: "assistant_output",
      content,
    },
  };
}

/**
 * @param {WebClientHarness} harness
 * @returns {string}
 */
function assistantText(harness) {
  return harness.document.getElementById("assistant-text")?.textContent ?? "";
}

/**
 * @param {WebClientHarness} harness
 * @returns {string[]}
 */
function fetchedMediaUrls(harness) {
  return harness.fetchCalls
    .filter((call) => call.url.includes("/api/media/"))
    .map((call) => decodeURIComponent(call.url));
}

/**
 * @param {Document} document
 * @param {string} id
 * @returns {HTMLButtonElement}
 */
function getButton(document, id) {
  const button = document.getElementById(id);
  assert.ok(button && "disabled" in button);
  return /** @type {HTMLButtonElement} */ (button);
}

/**
 * @param {unknown} turn
 * @returns {string}
 */
function commandTurnText(turn) {
  if (!turn || typeof turn !== "object" || !("content" in turn) || !Array.isArray(turn.content)) {
    return "";
  }
  const [block] = turn.content;
  return block && typeof block === "object" && "text" in block && typeof block.text === "string" ? block.text : "";
}

describe("web audio client assistant progress", () => {
  it("renders and plays each streamed assistant message before the next one arrives", async () => {
    const harness = createWebClientHarness();
    const submitPromise = harness.submitAudio(new Blob(["fake ogg"], { type: "audio/ogg" }));

    await waitFor(() => {
      assert.equal(harness.eventSources.length, 1);
      assert.equal(harness.resolvePost !== null, true);
    });
    assert.equal(harness.postSettled(), false);

    harness.eventSources[0]?.emit(assistantOutputRow("1", [
      { type: "text", text: "First intermediate message." },
    ]));
    harness.eventSources[0]?.emit(assistantOutputRow("2", [
      { type: "audio", path: "first.mp3", mime_type: "audio/mpeg" },
    ]));

    await waitFor(() => {
      assert.equal(assistantText(harness), "First intermediate message.");
      assert.deepEqual(fetchedMediaUrls(harness), [
        "http://api.test/api/media/first.mp3",
      ]);
      assert.deepEqual(harness.playCalls, ["blob:assistant-audio-1"]);
    });
    assert.equal(harness.postSettled(), false);
    assert.doesNotMatch(assistantText(harness), /Second intermediate message\./);

    harness.eventSources[0]?.emit(assistantOutputRow("3", [
      { type: "text", text: "Second intermediate message." },
    ]));
    harness.eventSources[0]?.emit(assistantOutputRow("4", [
      { type: "audio", path: "second.mp3", mime_type: "audio/mpeg" },
    ]));

    await waitFor(() => {
      assert.equal(assistantText(harness), "First intermediate message.\n\nSecond intermediate message.");
      assert.deepEqual(fetchedMediaUrls(harness), [
        "http://api.test/api/media/first.mp3",
        "http://api.test/api/media/second.mp3",
      ]);
      assert.deepEqual(harness.playCalls, [
        "blob:assistant-audio-1",
        "blob:assistant-audio-2",
      ]);
    });
    assert.equal(harness.postSettled(), false);

    harness.resolvePost?.();
    await submitPromise;

    assert.equal(harness.eventSources[0]?.closed, true);
    assert.deepEqual(fetchedMediaUrls(harness), [
      "http://api.test/api/media/first.mp3",
      "http://api.test/api/media/second.mp3",
    ]);
  });

  it("posts the existing cancel command while an audio turn is in flight", async () => {
    const harness = createWebClientHarness();
    const submitPromise = harness.submitAudio(new Blob(["fake ogg"], { type: "audio/ogg" }));

    await waitFor(() => {
      assert.equal(harness.eventSources.length, 1);
      assert.equal(harness.resolvePost !== null, true);
      assert.equal(getButton(harness.document, "cancel-turn").disabled, false);
    });
    await harness.cancelActiveTurn();

    assert.equal(harness.postSettled(), false);
    assert.equal(commandTurnText(harness.commandTurns.at(-1)), "!c");

    harness.resolvePost?.();
    await submitPromise;
  });

  it("posts the existing clear command and resets visible assistant text", async () => {
    const harness = createWebClientHarness();
    const assistant = harness.document.getElementById("assistant-text");
    if (assistant) {
      assistant.textContent = "Old response.";
    }

    await harness.clearMessageHistory();

    assert.equal(commandTurnText(harness.commandTurns.at(-1)), "/clear");
    assert.equal(assistantText(harness), "No response yet.");
  });
});
