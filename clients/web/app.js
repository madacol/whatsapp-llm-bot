import { OpenWakeWordJarvisDetector, OPEN_WAKE_WORD_MODEL_BASE_PATH } from "./openwakeword.js";

const STORAGE_KEY = "madabot.webAudioClient.settings.v1";
const LOCAL_DEV_API_BASE_URL = "http://127.0.0.1:3200";
const DEPLOYED_API_BASE_URL = "https://private-host-redacted";
const WAKE_DETECTOR_BUILD = "Local openWakeWord v13";
const DEFAULT_WAKE_THRESHOLD = 0.5;

/**
 * @typedef {new () => AudioContext} AudioContextConstructor
 *
 * @typedef {{ detected: boolean; label: string; score: number; threshold: number }} WakePredictionLike
 *
 * @typedef {import("./openwakeword.js").OrtLike} OrtLike
 */

const DEFAULT_SETTINGS = {
  baseUrl: defaultApiBaseUrl(),
  transportId: "voice",
  chatId: "api:web-1",
  senderId: "web-user",
  senderName: "Web",
  wakePhrase: "jarvis",
  wakeThreshold: DEFAULT_WAKE_THRESHOLD,
  wakeCaptureSeconds: 120,
  wakeSilenceSeconds: 1.5,
};

const PREFERRED_AUDIO_TYPES = [
  "audio/ogg; codecs=opus",
  "audio/webm; codecs=opus",
  "audio/mp4",
  "audio/ogg",
  "audio/webm",
];
const WAKE_PREROLL_MS = 500;
const WAKE_RECORDER_FRAME_MS = 80;
const VAD_RMS_THRESHOLD = 0.018;
const VAD_RELEASE_RMS_FLOOR = 0.012;
const VAD_START_BASELINE_MULTIPLIER = 1.65;
const VAD_RELEASE_BASELINE_MULTIPLIER = 1.28;
const VAD_START_MARGIN = 0.006;
const VAD_RELEASE_MARGIN = 0.004;
const VAD_BASELINE_ALPHA = 0.035;
const VAD_BASELINE_FAST_ALPHA = 0.18;
const VAD_POST_WAKE_CALIBRATION_MS = 350;
const VAD_NO_SPEECH_TIMEOUT_MS = 5000;
const VAD_POST_ROLL_MS = 300;
const WAKE_REARM_SUPPRESS_MS = 900;
const WAKE_CUE_TONES = [
  [660, 0.16],
  [0, 0.05],
  [990, 0.16],
  [0, 0.05],
  [1320, 0.24],
];
const END_CUE_TONES = [
  [1320, 0.12],
  [0, 0.04],
  [880, 0.14],
  [0, 0.04],
  [520, 0.2],
];
const WAKE_CUE_MS = WAKE_CUE_TONES.reduce((total, [, seconds]) => total + seconds * 1000, 0);

/** @type {{
 *   stream: MediaStream | null;
 *   recorder: MediaRecorder | null;
 *   chunks: Blob[];
 *   recordingStartedAt: number;
 *   timer: number;
 *   busy: boolean;
 *   busyCount: number;
 *   lastBlob: Blob | null;
 *   assistantAudioUrl: string;
 *   wakeListening: boolean;
 *   wakeTriggered: boolean;
 *   wakeRecorder: MediaRecorder | null;
 *   wakeChunks: { blob: Blob; at: number }[];
 *   wakeDetectedAt: number;
 *   wakeCaptureTimer: number;
 *   vadAudioContext: AudioContext | null;
 *   vadSource: MediaStreamAudioSourceNode | null;
 *   vadAnalyser: AnalyserNode | null;
 *   vadData: Uint8Array | null;
 *   vadFrame: number;
 *   vadLastVoiceAt: number;
 *   vadSpeechSeen: boolean;
 *   vadSilenceMs: number;
 *   vadNoSpeechTimeoutMs: number;
 *   vadPostRollMs: number;
 *   vadMaxUtteranceMs: number;
 *   vadIgnoreUntil: number;
 *   vadCalibrateUntil: number;
 *   vadCalibrationMinRms: number;
 *   vadLastStatusAt: number;
 *   vadBaselineRms: number;
 *   vadVoiceThresholdRms: number;
 *   vadReleaseThresholdRms: number;
 *   wakeAutoRestart: boolean;
 *   openWakeWord: OpenWakeWordJarvisDetector | null;
 *   openWakeWordConfigKey: string;
 *   localWakeAudioContext: AudioContext | null;
 *   localWakeSource: MediaStreamAudioSourceNode | null;
 *   localWakeProcessor: ScriptProcessorNode | null;
 *   localWakeMute: GainNode | null;
 *   localWakePcm: number[];
 *   localWakeInputRemainder: Float32Array;
 *   localWakeProcessChain: Promise<void>;
 *   localWakeLastScoreAt: number;
 *   localWakeSuppressUntil: number;
 *   diagnosticsHistory: unknown[];
 * }}
 */
const state = {
  stream: null,
  recorder: null,
  chunks: [],
  recordingStartedAt: 0,
  timer: 0,
  busy: false,
  busyCount: 0,
  lastBlob: null,
  assistantAudioUrl: "",
  wakeListening: false,
  wakeTriggered: false,
  wakeRecorder: null,
  wakeChunks: [],
  wakeDetectedAt: 0,
  wakeCaptureTimer: 0,
  vadAudioContext: null,
  vadSource: null,
  vadAnalyser: null,
  vadData: null,
  vadFrame: 0,
  vadLastVoiceAt: 0,
  vadSpeechSeen: false,
  vadSilenceMs: DEFAULT_SETTINGS.wakeSilenceSeconds * 1000,
  vadNoSpeechTimeoutMs: VAD_NO_SPEECH_TIMEOUT_MS,
  vadPostRollMs: VAD_POST_ROLL_MS,
  vadMaxUtteranceMs: DEFAULT_SETTINGS.wakeCaptureSeconds * 1000,
  vadIgnoreUntil: 0,
  vadCalibrateUntil: 0,
  vadCalibrationMinRms: Infinity,
  vadLastStatusAt: 0,
  vadBaselineRms: 0,
  vadVoiceThresholdRms: VAD_RMS_THRESHOLD,
  vadReleaseThresholdRms: VAD_RELEASE_RMS_FLOOR,
  wakeAutoRestart: false,
  openWakeWord: null,
  openWakeWordConfigKey: "",
  localWakeAudioContext: null,
  localWakeSource: null,
  localWakeProcessor: null,
  localWakeMute: null,
  localWakePcm: [],
  localWakeInputRemainder: new Float32Array(0),
  localWakeProcessChain: Promise.resolve(),
  localWakeLastScoreAt: 0,
  localWakeSuppressUntil: 0,
  diagnosticsHistory: [],
};

const els = {
  form: getElement("settings-form", HTMLFormElement),
  baseUrl: getElement("base-url", HTMLInputElement),
  transportId: getElement("transport-id", HTMLInputElement),
  chatId: getElement("chat-id", HTMLInputElement),
  senderId: getElement("sender-id", HTMLInputElement),
  senderName: getElement("sender-name", HTMLInputElement),
  wakePhrase: getElement("wake-phrase", HTMLInputElement),
  wakeThreshold: getElement("wake-threshold", HTMLInputElement),
  wakeCaptureSeconds: getElement("wake-capture-seconds", HTMLInputElement),
  wakeSilenceSeconds: getElement("wake-silence-seconds", HTMLInputElement),
  checkApi: getElement("check-api", HTMLButtonElement),
  enableMic: getElement("enable-mic", HTMLButtonElement),
  startRecording: getElement("start-recording", HTMLButtonElement),
  stopSend: getElement("stop-send", HTMLButtonElement),
  discardRecording: getElement("discard-recording", HTMLButtonElement),
  startListening: getElement("start-listening", HTMLButtonElement),
  stopListening: getElement("stop-listening", HTMLButtonElement),
  statePill: getElement("state-pill", HTMLSpanElement),
  statusText: getElement("status-text", HTMLSpanElement),
  wakeStatus: getElement("wake-status", HTMLElement),
  duration: getElement("duration", HTMLElement),
  inputFormat: getElement("input-format", HTMLElement),
  lastSize: getElement("last-size", HTMLElement),
  assistantText: getElement("assistant-text", HTMLElement),
  assistantAudio: getElement("assistant-audio", HTMLAudioElement),
  diagnostics: getElement("diagnostics-output", HTMLPreElement),
};

hydrateSettings();
renderCapability();
renderControls();

els.form.addEventListener("input", saveSettings);
els.wakePhrase.addEventListener("input", saveSettings);
els.wakeThreshold.addEventListener("input", saveSettings);
els.wakeCaptureSeconds.addEventListener("input", saveSettings);
els.wakeSilenceSeconds.addEventListener("input", saveSettings);
els.checkApi.addEventListener("click", () => void checkApi());
els.enableMic.addEventListener("click", () => void enableMicrophone());
els.startRecording.addEventListener("click", () => void startRecording());
els.stopSend.addEventListener("click", () => void stopAndSend());
els.discardRecording.addEventListener("click", () => void discardRecording());
els.startListening.addEventListener("click", () => void startWakeListening());
els.stopListening.addEventListener("click", () => void stopWakeListening("Detector stopped."));
window.addEventListener("beforeunload", cleanup);

/**
 * @template {HTMLElement} T
 * @param {string} id
 * @param {new (...args: never[]) => T} ctor
 * @returns {T}
 */
function getElement(id, ctor) {
  const element = document.getElementById(id);
  if (!(element instanceof ctor)) {
    throw new Error(`Missing #${id}`);
  }
  return element;
}

function hydrateSettings() {
  const settings = readStoredSettings();
  const urlSettings = readUrlSettings();
  const mergedSettings = {
    ...settings,
    ...urlSettings,
  };
  if (urlSettings.baseUrl) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(mergedSettings));
  }
  els.baseUrl.value = mergedSettings.baseUrl;
  els.transportId.value = mergedSettings.transportId;
  els.chatId.value = mergedSettings.chatId;
  els.senderId.value = mergedSettings.senderId;
  els.senderName.value = mergedSettings.senderName;
  els.wakePhrase.value = mergedSettings.wakePhrase;
  els.wakeThreshold.value = String(clampWakeThreshold(mergedSettings.wakeThreshold));
  els.wakeCaptureSeconds.value = String(mergedSettings.wakeCaptureSeconds);
  els.wakeSilenceSeconds.value = String(mergedSettings.wakeSilenceSeconds);
}

/**
 * @returns {string}
 */
function defaultApiBaseUrl() {
  return isLocalPage() ? LOCAL_DEV_API_BASE_URL : DEPLOYED_API_BASE_URL;
}

/**
 * @returns {boolean}
 */
function isLocalPage() {
  return location.hostname === "localhost"
    || location.hostname === "127.0.0.1"
    || location.hostname === "::1";
}

/**
 * @returns {Partial<typeof DEFAULT_SETTINGS>}
 */
function readUrlSettings() {
  const params = new URLSearchParams(location.search);
  const baseUrl = params.get("api") || params.get("apiBaseUrl") || params.get("baseUrl");
  /** @type {Partial<typeof DEFAULT_SETTINGS>} */
  const settings = {};
  if (baseUrl) {
    settings.baseUrl = stripTrailingSlash(baseUrl);
  }
  const wakeThreshold = params.get("wakeThreshold");
  if (wakeThreshold) {
    settings.wakeThreshold = clampWakeThreshold(Number.parseFloat(wakeThreshold));
  }
  const wakePhrase = params.get("wakePhrase");
  if (wakePhrase) {
    settings.wakePhrase = wakePhrase;
  }
  return settings;
}

/**
 * @returns {typeof DEFAULT_SETTINGS}
 */
function readStoredSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (!stored || typeof stored !== "object") {
      return { ...DEFAULT_SETTINGS };
    }
    const storedBaseUrl = stringOrDefault(stored.baseUrl, DEFAULT_SETTINGS.baseUrl);
    return {
      baseUrl: normalizeStoredBaseUrl(storedBaseUrl),
      transportId: stringOrDefault(stored.transportId, DEFAULT_SETTINGS.transportId),
      chatId: stringOrDefault(stored.chatId, DEFAULT_SETTINGS.chatId),
      senderId: stringOrDefault(stored.senderId, DEFAULT_SETTINGS.senderId),
      senderName: stringOrDefault(stored.senderName, DEFAULT_SETTINGS.senderName),
      wakePhrase: stringOrDefault(stored.wakePhrase, DEFAULT_SETTINGS.wakePhrase),
      wakeThreshold: clampWakeThreshold(numberOrDefault(stored.wakeThreshold, DEFAULT_SETTINGS.wakeThreshold)),
      wakeCaptureSeconds: numberOrDefault(stored.wakeCaptureSeconds, DEFAULT_SETTINGS.wakeCaptureSeconds),
      wakeSilenceSeconds: numberOrDefault(stored.wakeSilenceSeconds, DEFAULT_SETTINGS.wakeSilenceSeconds),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string}
 */
function stringOrDefault(value, fallback) {
  return typeof value === "string" && value.trim() ? value : fallback;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function numberOrDefault(value, fallback) {
  const number = typeof value === "number" ? value : Number.parseFloat(String(value));
  return Number.isFinite(number) ? number : fallback;
}

/**
 * @param {string} baseUrl
 * @returns {string}
 */
function normalizeStoredBaseUrl(baseUrl) {
  if (!isLocalPage() && isLoopbackUrl(baseUrl)) {
    return DEPLOYED_API_BASE_URL;
  }
  return baseUrl;
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isLoopbackUrl(value) {
  try {
    const url = new URL(value);
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  } catch {
    return false;
  }
}

function saveSettings() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(readSettings()));
}

/**
 * @returns {typeof DEFAULT_SETTINGS}
 */
function readSettings() {
  const wakePhrase = els.wakePhrase.value.trim();
  return {
    baseUrl: stripTrailingSlash(els.baseUrl.value),
    transportId: els.transportId.value.trim(),
    chatId: els.chatId.value.trim(),
    senderId: els.senderId.value.trim(),
    senderName: els.senderName.value.trim(),
    wakePhrase,
    wakeThreshold: clampWakeThreshold(Number.parseFloat(els.wakeThreshold.value)),
    wakeCaptureSeconds: clampWakeCaptureSeconds(Number.parseFloat(els.wakeCaptureSeconds.value)),
    wakeSilenceSeconds: clampWakeSilenceSeconds(Number.parseFloat(els.wakeSilenceSeconds.value)),
  };
}

/**
 * @param {number} value
 * @returns {number}
 */
function clampWakeCaptureSeconds(value) {
  if (!Number.isFinite(value)) {
    return DEFAULT_SETTINGS.wakeCaptureSeconds;
  }
  return Math.min(120, Math.max(2, Math.round(value)));
}

/**
 * @param {number} value
 * @returns {number}
 */
function clampWakeSilenceSeconds(value) {
  if (!Number.isFinite(value)) {
    return DEFAULT_SETTINGS.wakeSilenceSeconds;
  }
  return Math.min(5, Math.max(0.5, Math.round(value * 10) / 10));
}

/**
 * @param {number} value
 * @returns {number}
 */
function clampWakeThreshold(value) {
  if (!Number.isFinite(value)) {
    return DEFAULT_WAKE_THRESHOLD;
  }
  return Math.min(0.95, Math.max(0.05, Math.round(value * 20) / 20));
}

/**
 * @param {string} value
 * @returns {string}
 */
function stripTrailingSlash(value) {
  let trimmed = value.trim();
  while (trimmed.endsWith("/")) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

function renderCapability() {
  if (!isSecureContext) {
    setStatus("Error", "Microphone access requires HTTPS, localhost, or another secure context.", "error");
  } else if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("Error", "This browser does not expose microphone capture.", "error");
  } else if (typeof MediaRecorder === "undefined") {
    setStatus("Error", "This browser does not support MediaRecorder.", "error");
  }
  els.inputFormat.textContent = preferredMimeType() || "Browser default";
  els.wakeStatus.textContent = localWakeSupported()
    ? `Detector idle. ${WAKE_DETECTOR_BUILD} loaded.`
    : "Local Jarvis detection is not available in this browser.";
}

/**
 * @returns {string}
 */
function preferredMimeType() {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return "";
  }
  return PREFERRED_AUDIO_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

/**
 * @returns {OrtLike | null}
 */
function ortRuntime() {
  const ortWindow = /** @type {Window & { ort?: OrtLike }} */ (/** @type {unknown} */ (window));
  return ortWindow.ort ?? null;
}

/**
 * @returns {boolean}
 */
function localWakeSupported() {
  return isSecureContext
    && Boolean(navigator.mediaDevices?.getUserMedia)
    && typeof MediaRecorder !== "undefined"
    && typeof WebAssembly !== "undefined"
    && audioContextCtor() !== null
    && ortRuntime() !== null;
}

/**
 * @returns {AudioContextConstructor | null}
 */
function audioContextCtor() {
  const audioWindow = /** @type {Window & {
   *   AudioContext?: AudioContextConstructor;
   *   webkitAudioContext?: AudioContextConstructor;
   * }} */ (window);
  return audioWindow.AudioContext ?? audioWindow.webkitAudioContext ?? null;
}

/**
 * @returns {MediaStreamTrack | null}
 */
function liveAudioTrack() {
  return state.stream?.getAudioTracks().find((track) => track.readyState === "live") ?? null;
}

/**
 * @returns {boolean}
 */
function hasLiveMicrophone() {
  return liveAudioTrack() !== null;
}

async function checkApi() {
  const settings = readSettings();
  saveSettings();
  try {
    validateApiBaseUrl(settings.baseUrl);
    setBusy(true);
    setStatus("Checking", "Checking API health.");
    const response = await fetch(buildApiUrl(settings.baseUrl, "/health"));
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${body}`);
    }
    setStatus("Ready", "API health check passed.");
    writeDiagnostics({ health: parseJsonOrText(body) });
  } catch (error) {
    handleError(error);
  } finally {
    setBusy(false);
  }
}

async function enableMicrophone() {
  if (!isSecureContext) {
    throwAndShow("Microphone access requires HTTPS, localhost, or another secure context.");
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throwAndShow("This browser does not expose microphone capture.");
    return;
  }
  if (hasLiveMicrophone()) {
    setStatus("Ready", "Microphone is already enabled.");
    renderControls();
    return;
  }
  try {
    setBusy(true);
    releaseMicrophone();
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    setStatus("Ready", "Microphone is enabled.");
  } catch (error) {
    handleError(error);
  } finally {
    setBusy(false);
    renderControls();
  }
}

async function startRecording() {
  try {
    clearWakeCaptureTimer();
    if (!state.stream) {
      await enableMicrophone();
    }
    const stream = state.stream;
    if (!stream) {
      return;
    }
    saveSettings();
    const mimeType = preferredMimeType();
    state.chunks = [];
    state.lastBlob = null;
    state.recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    state.recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) {
        state.chunks.push(event.data);
      }
    });
    state.recorder.start(250);
    state.recordingStartedAt = performance.now();
    state.timer = window.setInterval(renderDuration, 100);
    setStatus("Recording", "Recording microphone audio.", "recording");
    renderControls();
  } catch (error) {
    handleError(error);
    renderControls();
  }
}

async function stopAndSend() {
  try {
    clearWakeCaptureTimer();
    const blob = await stopRecording();
    if (!blob || blob.size === 0) {
      setStatus("Ready", "No audio captured.");
      return;
    }
    state.lastBlob = blob;
    els.lastSize.textContent = formatBytes(blob.size);
    await submitAudio(blob);
  } catch (error) {
    handleError(error);
  } finally {
    renderControls();
  }
}

async function discardRecording() {
  try {
    clearWakeCaptureTimer();
    await stopRecording();
    setStatus("Ready", "Recording discarded.");
  } catch (error) {
    handleError(error);
  } finally {
    renderControls();
  }
}

/**
 * @returns {Promise<Blob | null>}
 */
function stopRecording() {
  clearWakeCaptureTimer();
  const recorder = state.recorder;
  if (!recorder || recorder.state === "inactive") {
    stopTimer();
    return Promise.resolve(null);
  }
  return new Promise((resolve, reject) => {
    recorder.addEventListener("stop", () => {
      stopTimer();
      const type = recorder.mimeType || preferredMimeType() || "audio/webm";
      resolve(new Blob(state.chunks, { type }));
      state.recorder = null;
      state.chunks = [];
    }, { once: true });
    recorder.addEventListener("error", () => {
      stopTimer();
      reject(new Error("Recording failed."));
    }, { once: true });
    recorder.stop();
  });
}

async function startWakeListening() {
  const settings = readSettings();
  await startLocalWakeListening(settings);
}

/**
 * @param {typeof DEFAULT_SETTINGS} settings
 * @returns {Promise<void>}
 */
async function startLocalWakeListening(settings) {
  if (!localWakeSupported()) {
    throwAndShow("Local Jarvis detection is not available in this browser.");
    return;
  }
  if (!isJarvisWakePhrase(settings.wakePhrase)) {
    throwAndShow("Local openWakeWord currently supports the Jarvis wake phrase.");
    return;
  }
  saveSettings();

  try {
    clearWakeCaptureTimer();
    stopSilenceDetection();
    stopLocalWakeProcessing(false);
    state.wakeTriggered = false;
    state.wakeDetectedAt = 0;
    state.wakeAutoRestart = true;
    state.wakeListening = true;
    await ensureOpenWakeWord(settings);
    if (!hasLiveMicrophone()) {
      await enableMicrophone();
    }
    if (!hasLiveMicrophone()) {
      throw new Error("Microphone is not enabled.");
    }
    await startLocalWakeProcessing();
    setWakeStatus(`Listening locally for "${settings.wakePhrase}".`);
    setStatus("Listening", `Listening locally for "${settings.wakePhrase}".`);
    appendDiagnostics({
      localWake: {
        event: "start",
        engine: "openwakeword",
        wakePhrase: settings.wakePhrase,
        threshold: settings.wakeThreshold,
        modelBasePath: OPEN_WAKE_WORD_MODEL_BASE_PATH,
        sampleRate: state.openWakeWord?.sampleRate ?? 0,
        frameLength: state.openWakeWord?.frameLength ?? 0,
      },
    });
  } catch (error) {
    state.wakeListening = false;
    state.wakeTriggered = false;
    stopLocalWakeProcessing(false);
    stopSilenceDetection();
    await releaseOpenWakeWord().catch(() => undefined);
    handleError(error);
  } finally {
    renderControls();
  }
}

/**
 * @param {typeof DEFAULT_SETTINGS} settings
 * @returns {Promise<void>}
 */
async function ensureOpenWakeWord(settings) {
  const ort = ortRuntime();
  if (!ort) {
    throw new Error("ONNX Runtime Web is not loaded.");
  }
  configureOrtRuntime(ort);
  const configKey = openWakeWordConfigKey(settings);
  if (state.openWakeWord && state.openWakeWordConfigKey === configKey) {
    return;
  }
  await releaseOpenWakeWord();
  state.openWakeWord = await OpenWakeWordJarvisDetector.create(ort, {
    modelBasePath: OPEN_WAKE_WORD_MODEL_BASE_PATH,
    threshold: settings.wakeThreshold,
  });
  state.openWakeWordConfigKey = configKey;
}

/**
 * @param {typeof DEFAULT_SETTINGS} settings
 * @returns {string}
 */
function openWakeWordConfigKey(settings) {
  return JSON.stringify({
    threshold: settings.wakeThreshold,
  });
}

/**
 * @param {OrtLike} ort
 * @returns {void}
 */
function configureOrtRuntime(ort) {
  if (!ort.env?.wasm) {
    return;
  }
  ort.env.wasm.wasmPaths = {
    mjs: "/vendor/onnxruntime/ort-wasm-simd-threaded.mjs",
    wasm: "/vendor/onnxruntime/ort-wasm-simd-threaded.wasm",
  };
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
}

/**
 * @param {WakePredictionLike} prediction
 * @returns {void}
 */
function handleOpenWakeWordDetection(prediction) {
  if (!state.wakeListening || state.wakeTriggered || state.recorder) {
    return;
  }
  if (shouldSuppressLocalWakeDetection()) {
    state.openWakeWord?.reset();
    state.localWakePcm = [];
    state.localWakeInputRemainder = new Float32Array(0);
    appendDiagnostics({
      localWake: {
        event: "suppressed-detection-after-rearm",
        keyword: prediction.label,
        score: Number(prediction.score.toFixed(3)),
        threshold: prediction.threshold,
      },
    });
    return;
  }
  const settings = readSettings();
  state.wakeTriggered = true;
  appendDiagnostics({
    localWake: {
      event: "detected",
      keyword: prediction.label,
      score: Number(prediction.score.toFixed(3)),
      threshold: prediction.threshold,
      engine: "openwakeword",
    },
  });
  setWakeStatus("Jarvis detected locally.");
  void triggerWakeCapture(settings);
}

/**
 * @returns {Promise<void>}
 */
async function startLocalWakeProcessing() {
  stopLocalWakeProcessing(true);
  const stream = state.stream;
  const detector = state.openWakeWord;
  const AudioContextClass = audioContextCtor();
  if (!stream || !detector || !AudioContextClass) {
    throw new Error("Local wake detector is not ready.");
  }
  detector.reset();
  const audioContext = new AudioContextClass();
  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const mute = audioContext.createGain();
  mute.gain.value = 0;
  processor.onaudioprocess = (event) => {
    processLocalWakeInput(event.inputBuffer.getChannelData(0), audioContext.sampleRate);
  };
  source.connect(processor);
  processor.connect(mute);
  mute.connect(audioContext.destination);
  state.localWakeAudioContext = audioContext;
  state.localWakeSource = source;
  state.localWakeProcessor = processor;
  state.localWakeMute = mute;
  state.localWakePcm = [];
  state.localWakeInputRemainder = new Float32Array(0);
  state.localWakeProcessChain = Promise.resolve();
  state.localWakeLastScoreAt = 0;
  await audioContext.resume().catch(() => undefined);
}

/**
 * @returns {boolean}
 */
function shouldSuppressLocalWakeDetection() {
  if (!state.localWakeSuppressUntil) {
    return false;
  }
  if (performance.now() < state.localWakeSuppressUntil) {
    return true;
  }
  state.localWakeSuppressUntil = 0;
  return false;
}

/**
 * @param {Float32Array} input
 * @param {number} inputSampleRate
 * @returns {void}
 */
function processLocalWakeInput(input, inputSampleRate) {
  const detector = state.openWakeWord;
  if (!detector || !state.wakeListening || state.wakeTriggered) {
    return;
  }
  const samples = resampleToInt16(input, inputSampleRate, detector.sampleRate);
  if (samples.length === 0) {
    return;
  }
  for (const sample of samples) {
    state.localWakePcm.push(sample);
  }
  const maxQueueSamples = detector.sampleRate * 5;
  if (state.localWakePcm.length > maxQueueSamples) {
    state.localWakePcm.splice(0, state.localWakePcm.length - maxQueueSamples);
  }
  while (state.localWakePcm.length >= detector.frameLength) {
    const frame = Int16Array.from(state.localWakePcm.slice(0, detector.frameLength));
    state.localWakePcm.splice(0, detector.frameLength);
    enqueueOpenWakeWordFrame(frame);
  }
}

/**
 * @param {Int16Array} frame
 * @returns {void}
 */
function enqueueOpenWakeWordFrame(frame) {
  state.localWakeProcessChain = state.localWakeProcessChain
    .then(async () => {
      const detector = state.openWakeWord;
      if (!detector || !state.wakeListening || state.wakeTriggered) {
        return;
      }
      const prediction = await detector.process(frame);
      renderLocalWakeScore(prediction);
      if (prediction.detected) {
        handleOpenWakeWordDetection(prediction);
      }
    })
    .catch((error) => {
      const message = errorMessage(error);
      appendDiagnostics({ localWake: { event: "process-failed", message } });
      void stopWakeListening("Detector stopped.");
      handleError(new Error(`Local openWakeWord detection failed: ${message}`));
    });
}

/**
 * @param {WakePredictionLike} prediction
 * @returns {void}
 */
function renderLocalWakeScore(prediction) {
  const now = performance.now();
  if (now - state.localWakeLastScoreAt < 1000 || state.wakeTriggered || !state.wakeListening) {
    return;
  }
  state.localWakeLastScoreAt = now;
  setWakeStatus(
    `Listening locally for "${readSettings().wakePhrase}". Wake score ${prediction.score.toFixed(3)}/${prediction.threshold.toFixed(2)}.`,
  );
}

/**
 * @param {Float32Array} input
 * @param {number} inputSampleRate
 * @param {number} outputSampleRate
 * @returns {Int16Array}
 */
function resampleToInt16(input, inputSampleRate, outputSampleRate) {
  if (inputSampleRate <= 0 || outputSampleRate <= 0) {
    return new Int16Array(0);
  }
  if (Math.abs(inputSampleRate - outputSampleRate) < 1) {
    return float32ToInt16(input);
  }
  const source = state.localWakeInputRemainder.length
    ? concatenateFloat32(state.localWakeInputRemainder, input)
    : input;
  const ratio = inputSampleRate / outputSampleRate;
  const outputLength = Math.floor(source.length / ratio);
  if (outputLength <= 0) {
    state.localWakeInputRemainder = source.slice();
    return new Int16Array(0);
  }
  const consumed = Math.min(source.length, Math.floor(outputLength * ratio));
  state.localWakeInputRemainder = source.slice(consumed);
  const output = new Int16Array(outputLength);
  for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
    const start = Math.floor(outputIndex * ratio);
    const end = Math.min(consumed, Math.max(start + 1, Math.floor((outputIndex + 1) * ratio)));
    let sum = 0;
    for (let inputIndex = start; inputIndex < end; inputIndex += 1) {
      sum += source[inputIndex] ?? 0;
    }
    output[outputIndex] = floatSampleToInt16(sum / (end - start));
  }
  return output;
}

/**
 * @param {Float32Array} samples
 * @returns {Int16Array}
 */
function float32ToInt16(samples) {
  const output = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    output[index] = floatSampleToInt16(samples[index] ?? 0);
  }
  return output;
}

/**
 * @param {number} sample
 * @returns {number}
 */
function floatSampleToInt16(sample) {
  const clipped = Math.max(-1, Math.min(1, sample));
  return clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff;
}

/**
 * @param {Float32Array} first
 * @param {Float32Array} second
 * @returns {Float32Array}
 */
function concatenateFloat32(first, second) {
  const combined = new Float32Array(first.length + second.length);
  combined.set(first, 0);
  combined.set(second, first.length);
  return combined;
}

/**
 * @param {typeof DEFAULT_SETTINGS} settings
 * @returns {Promise<void>}
 */
async function triggerWakeCapture(settings) {
  state.wakeListening = false;
  stopLocalWakeProcessing(true);
  if (!hasLiveMicrophone()) {
    await enableMicrophone();
  }
  if (!hasLiveMicrophone()) {
    setStatus("Error", "Microphone is not enabled for wake capture.", "error");
    setWakeStatus("Wake phrase detected, but microphone capture did not start.");
    return;
  }
  const captureStartedAt = performance.now();
  state.wakeDetectedAt = captureStartedAt;
  state.vadLastVoiceAt = captureStartedAt;
  state.vadSpeechSeen = false;
  state.vadSilenceMs = settings.wakeSilenceSeconds * 1000;
  state.vadNoSpeechTimeoutMs = VAD_NO_SPEECH_TIMEOUT_MS;
  state.vadPostRollMs = VAD_POST_ROLL_MS;
  state.vadMaxUtteranceMs = settings.wakeCaptureSeconds * 1000;
  state.vadIgnoreUntil = captureStartedAt + WAKE_CUE_MS;
  state.vadCalibrateUntil = state.vadIgnoreUntil + VAD_POST_WAKE_CALIBRATION_MS;
  state.vadCalibrationMinRms = Infinity;
  state.vadLastStatusAt = 0;
  state.vadBaselineRms = 0;
  const thresholds = vadThresholds(state.vadBaselineRms);
  state.vadVoiceThresholdRms = thresholds.voice;
  state.vadReleaseThresholdRms = thresholds.release;
  startWakeRecorder();
  startSilenceDetection(settings);
  setStatus("Detected", "Wake phrase detected. Capturing command.", "recording");
  void playCue(WAKE_CUE_TONES);
  state.recordingStartedAt = performance.now();
  state.timer = window.setInterval(renderDuration, 100);
  const captureMs = settings.wakeCaptureSeconds * 1000;
  setWakeStatus(`Capturing until speech ends, ${settings.wakeCaptureSeconds}s max.`);
  state.wakeCaptureTimer = window.setTimeout(() => {
    void finishWakeCapture("Max utterance reached; submitting.");
  }, captureMs);
  renderControls();
}

function startWakeRecorder() {
  const stream = state.stream;
  if (!stream) {
    throw new Error("Microphone is not enabled.");
  }
  const mimeType = preferredMimeType();
  const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  state.wakeChunks = [];
  state.wakeRecorder = recorder;
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size === 0) {
      return;
    }
    state.wakeChunks.push({ blob: event.data, at: performance.now() });
    trimWakeChunks();
  });
  recorder.addEventListener("error", () => {
    void stopWakeListening("Detector stopped.");
    handleError(new Error("Wake capture failed."));
  });
  recorder.start(WAKE_RECORDER_FRAME_MS);
}

/**
 * @param {typeof DEFAULT_SETTINGS} settings
 * @returns {void}
 */
function startSilenceDetection(settings) {
  stopSilenceDetection();
  state.vadSilenceMs = settings.wakeSilenceSeconds * 1000;
  state.vadBaselineRms = state.vadBaselineRms || 0;
  const thresholds = vadThresholds(state.vadBaselineRms);
  state.vadVoiceThresholdRms = thresholds.voice;
  state.vadReleaseThresholdRms = thresholds.release;
  const stream = state.stream;
  const AudioContextClass = audioContextCtor();
  if (!stream || !AudioContextClass) {
    return;
  }
  const audioContext = new AudioContextClass();
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.15;
  source.connect(analyser);
  state.vadAudioContext = audioContext;
  state.vadSource = source;
  state.vadAnalyser = analyser;
  state.vadData = new Uint8Array(analyser.fftSize);
  state.vadLastVoiceAt = performance.now();
  state.vadSpeechSeen = false;
  state.vadLastStatusAt = 0;
  void audioContext.resume().catch(() => undefined);
  state.vadFrame = window.requestAnimationFrame(runSilenceDetectionFrame);
}

function runSilenceDetectionFrame() {
  const analyser = state.vadAnalyser;
  const data = state.vadData;
  if (!analyser || !data) {
    state.vadFrame = 0;
    return;
  }

  if (state.wakeTriggered && state.wakeDetectedAt) {
    const now = performance.now();
    const elapsed = now - state.wakeDetectedAt;
    if (elapsed >= state.vadMaxUtteranceMs) {
      void finishWakeCapture("Max utterance reached; submitting.");
      return;
    }

    if (now < state.vadIgnoreUntil) {
      state.vadFrame = window.requestAnimationFrame(runSilenceDetectionFrame);
      return;
    }

    const rms = currentRms(analyser, data);
    if (now < state.vadCalibrateUntil) {
      state.vadCalibrationMinRms = Math.min(state.vadCalibrationMinRms, rms);
      state.vadBaselineRms = Number.isFinite(state.vadCalibrationMinRms)
        ? state.vadCalibrationMinRms
        : updateRmsBaseline(state.vadBaselineRms, rms);
      const thresholds = vadThresholds(state.vadBaselineRms);
      state.vadVoiceThresholdRms = thresholds.voice;
      state.vadReleaseThresholdRms = thresholds.release;
      renderVadCalibrationStatus(now, rms);
      state.vadFrame = window.requestAnimationFrame(runSilenceDetectionFrame);
      return;
    }

    if (!state.vadBaselineRms) {
      state.vadBaselineRms = Number.isFinite(state.vadCalibrationMinRms)
        ? state.vadCalibrationMinRms
        : rms;
    }
    const thresholds = vadThresholds(state.vadBaselineRms);
    const voiceThreshold = state.vadSpeechSeen ? thresholds.release : thresholds.voice;
    const isVoice = rms >= voiceThreshold;
    state.vadVoiceThresholdRms = thresholds.voice;
    state.vadReleaseThresholdRms = thresholds.release;

    if (isVoice) {
      state.vadSpeechSeen = true;
      state.vadLastVoiceAt = now;
    } else {
      state.vadBaselineRms = updateRmsBaseline(state.vadBaselineRms, rms);
    }

    if (state.vadSpeechSeen) {
      const silentFor = now - state.vadLastVoiceAt;
      renderVadStatus(now, rms, silentFor);
      if (silentFor >= state.vadSilenceMs + state.vadPostRollMs) {
        void finishWakeCapture("Silence detected; submitting.");
        return;
      }
    } else {
      renderVadStatus(now, rms, 0);
      if (elapsed >= state.vadNoSpeechTimeoutMs) {
        void finishWakeCapture("No speech detected; submitting.");
        return;
      }
    }
  }

  state.vadFrame = window.requestAnimationFrame(runSilenceDetectionFrame);
}

/**
 * @param {number} now
 * @param {number} rms
 * @returns {void}
 */
function renderVadCalibrationStatus(now, rms) {
  if (now - state.vadLastStatusAt < 250) {
    return;
  }
  state.vadLastStatusAt = now;
  setWakeStatus(
    `Capturing command. Calibrating ambient RMS ${state.vadBaselineRms.toFixed(3)} from current ${rms.toFixed(3)}.`,
  );
}

/**
 * @param {number} baseline
 * @returns {{ voice: number, release: number }}
 */
function vadThresholds(baseline) {
  const ambient = Math.max(0, baseline || 0);
  return {
    voice: Math.max(VAD_RMS_THRESHOLD, ambient * VAD_START_BASELINE_MULTIPLIER + VAD_START_MARGIN),
    release: Math.max(VAD_RELEASE_RMS_FLOOR, ambient * VAD_RELEASE_BASELINE_MULTIPLIER + VAD_RELEASE_MARGIN),
  };
}

/**
 * @param {number} baseline
 * @param {number} rms
 * @returns {number}
 */
function updateRmsBaseline(baseline, rms) {
  if (!Number.isFinite(rms) || rms <= 0) {
    return baseline;
  }
  if (!Number.isFinite(baseline) || baseline <= 0) {
    return rms;
  }
  const alpha = rms < baseline ? VAD_BASELINE_FAST_ALPHA : VAD_BASELINE_ALPHA;
  return baseline + (rms - baseline) * alpha;
}

/**
 * @param {AnalyserNode} analyser
 * @param {Uint8Array} data
 * @returns {number}
 */
function currentRms(analyser, data) {
  analyser.getByteTimeDomainData(data);
  let sumSquares = 0;
  for (const sample of data) {
    const centered = (sample - 128) / 128;
    sumSquares += centered * centered;
  }
  return Math.sqrt(sumSquares / data.length);
}

/**
 * @param {number} now
 * @param {number} rms
 * @param {number} silentForMs
 * @returns {void}
 */
function renderVadStatus(now, rms, silentForMs) {
  if (now - state.vadLastStatusAt < 500) {
    return;
  }
  state.vadLastStatusAt = now;
  const stopAfterMs = state.vadSilenceMs + state.vadPostRollMs;
  if (state.vadSpeechSeen) {
    setWakeStatus(
      `Capturing command. RMS ${rms.toFixed(3)} / ${state.vadReleaseThresholdRms.toFixed(3)} release. Ambient ${state.vadBaselineRms.toFixed(3)}. Silence ${(silentForMs / 1000).toFixed(1)}s/${(stopAfterMs / 1000).toFixed(1)}s.`,
    );
  } else {
    setWakeStatus(
      `Capturing command. Waiting for speech. RMS ${rms.toFixed(3)} / ${state.vadVoiceThresholdRms.toFixed(3)} voice. Ambient ${state.vadBaselineRms.toFixed(3)}.`,
    );
  }
}

function stopSilenceDetection() {
  if (state.vadFrame) {
    window.cancelAnimationFrame(state.vadFrame);
    state.vadFrame = 0;
  }
  state.vadSource?.disconnect();
  state.vadAnalyser?.disconnect();
  const audioContext = state.vadAudioContext;
  state.vadAudioContext = null;
  state.vadSource = null;
  state.vadAnalyser = null;
  state.vadData = null;
  state.vadLastVoiceAt = 0;
  state.vadSpeechSeen = false;
  state.vadIgnoreUntil = 0;
  state.vadCalibrateUntil = 0;
  state.vadCalibrationMinRms = Infinity;
  state.vadLastStatusAt = 0;
  state.vadBaselineRms = 0;
  state.vadVoiceThresholdRms = VAD_RMS_THRESHOLD;
  state.vadReleaseThresholdRms = VAD_RELEASE_RMS_FLOOR;
  if (audioContext && audioContext.state !== "closed") {
    void audioContext.close().catch(() => undefined);
  }
}

/**
 * @param {string} message
 * @returns {Promise<void>}
 */
async function finishWakeCapture(message) {
  clearWakeCaptureTimer();
  stopSilenceDetection();
  try {
    const blob = await stopWakeRecorder(true);
    stopTimer();
    state.wakeTriggered = false;
    state.wakeDetectedAt = 0;
    if (!blob || blob.size === 0) {
      setStatus("Ready", "No wake audio captured.");
      setWakeStatus("No wake audio captured.");
      return;
    }
    state.lastBlob = blob;
    els.lastSize.textContent = formatBytes(blob.size);
    setWakeStatus(message);
    void playCue(END_CUE_TONES);
    if (state.wakeAutoRestart) {
      void restartWakeListeningAfterCapture();
    }
    void submitWakeAudioInBackground(blob);
  } catch (error) {
    handleError(error);
  } finally {
    renderControls();
  }
}

/**
 * @returns {Promise<void>}
 */
async function restartWakeListeningAfterCapture() {
  if (!state.wakeAutoRestart || state.wakeListening || state.wakeTriggered || state.recorder || state.wakeRecorder) {
    return;
  }
  try {
    state.localWakeSuppressUntil = performance.now() + WAKE_REARM_SUPPRESS_MS;
    setWakeStatus("Restarting wake listener.");
    await startWakeListening();
  } catch (error) {
    handleError(error);
  }
}

/**
 * @param {Blob} blob
 * @returns {Promise<void>}
 */
async function submitWakeAudioInBackground(blob) {
  try {
    await submitAudio(blob);
  } catch (error) {
    handleError(error);
  } finally {
    renderControls();
  }
}

/**
 * @param {number[][]} tones
 * @returns {Promise<void>}
 */
async function playCue(tones) {
  const AudioContextClass = audioContextCtor();
  if (!AudioContextClass) {
    return;
  }
  const audioContext = new AudioContextClass();
  await audioContext.resume().catch(() => undefined);
  let cursor = audioContext.currentTime;
  const gain = audioContext.createGain();
  gain.gain.value = 0.16;
  gain.connect(audioContext.destination);

  for (const [frequency, seconds] of tones) {
    if (frequency > 0) {
      const oscillator = audioContext.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      oscillator.connect(gain);
      oscillator.start(cursor);
      oscillator.stop(cursor + seconds);
    }
    cursor += seconds;
  }

  window.setTimeout(() => {
    void audioContext.close().catch(() => undefined);
  }, Math.ceil((cursor - audioContext.currentTime) * 1000) + 100);
}

/**
 * @param {boolean} keepTriggeredWindow
 * @returns {Promise<Blob | null>}
 */
function stopWakeRecorder(keepTriggeredWindow) {
  const recorder = state.wakeRecorder;
  if (!recorder || recorder.state === "inactive") {
    state.wakeRecorder = null;
    state.wakeChunks = [];
    return Promise.resolve(null);
  }
  return new Promise((resolve, reject) => {
    recorder.addEventListener("stop", () => {
      const type = recorder.mimeType || preferredMimeType() || "audio/webm";
      const blobs = wakeCaptureBlobs(keepTriggeredWindow);
      state.wakeRecorder = null;
      state.wakeChunks = [];
      resolve(blobs.length ? new Blob(blobs, { type }) : null);
    }, { once: true });
    recorder.addEventListener("error", () => {
      state.wakeRecorder = null;
      state.wakeChunks = [];
      reject(new Error("Wake capture failed."));
    }, { once: true });
    recorder.stop();
  });
}

/**
 * @param {boolean} keepTriggeredWindow
 * @returns {Blob[]}
 */
function wakeCaptureBlobs(keepTriggeredWindow) {
  if (!keepTriggeredWindow || !state.wakeDetectedAt) {
    return [];
  }
  const earliest = state.wakeDetectedAt - WAKE_PREROLL_MS;
  return state.wakeChunks
    .filter((chunk) => chunk.at >= earliest)
    .map((chunk) => chunk.blob);
}

function trimWakeChunks() {
  const detectedAt = state.wakeDetectedAt;
  const now = performance.now();
  const earliest = detectedAt
    ? detectedAt - WAKE_PREROLL_MS
    : now - WAKE_PREROLL_MS;
  state.wakeChunks = state.wakeChunks.filter((chunk) => chunk.at >= earliest);
}

/**
 * @param {string} phrase
 * @returns {boolean}
 */
function isJarvisWakePhrase(phrase) {
  const normalizedPhrase = normalizeWakeText(phrase);
  return normalizedPhrase === "jarvis" || normalizedPhrase === "hey jarvis";
}

/**
 * @param {string} text
 * @returns {string}
 */
function normalizeWakeText(text) {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * @param {string} message
 * @returns {Promise<void>}
 */
async function stopWakeListening(message = "Detector stopped.") {
  const wasWakeCapturing = state.wakeTriggered;
  state.wakeAutoRestart = false;
  state.wakeListening = false;
  state.wakeTriggered = false;
  state.wakeDetectedAt = 0;
  state.localWakeSuppressUntil = 0;
  clearWakeCaptureTimer();
  if (wasWakeCapturing) {
    stopTimer();
  }
  stopLocalWakeProcessing(true);
  stopSilenceDetection();
  await stopWakeRecorder(false).catch((error) => handleError(error));
  await releaseOpenWakeWord().catch((error) => handleError(error));
  releaseMicrophone();
  if (message) {
    setWakeStatus(message);
  }
  renderControls();
}

/**
 * @param {boolean} resetAudioQueue
 * @returns {void}
 */
function stopLocalWakeProcessing(resetAudioQueue) {
  const processor = state.localWakeProcessor;
  if (processor) {
    processor.onaudioprocess = null;
  }
  state.localWakeSource?.disconnect();
  state.localWakeProcessor?.disconnect();
  state.localWakeMute?.disconnect();
  const audioContext = state.localWakeAudioContext;
  state.localWakeAudioContext = null;
  state.localWakeSource = null;
  state.localWakeProcessor = null;
  state.localWakeMute = null;
  if (resetAudioQueue) {
    state.localWakePcm = [];
    state.localWakeInputRemainder = new Float32Array(0);
    state.localWakeProcessChain = Promise.resolve();
    state.localWakeLastScoreAt = 0;
  }
  if (audioContext && audioContext.state !== "closed") {
    void audioContext.close().catch(() => undefined);
  }
}

/**
 * @returns {Promise<void>}
 */
async function releaseOpenWakeWord() {
  const detector = state.openWakeWord;
  state.openWakeWord = null;
  state.openWakeWordConfigKey = "";
  if (detector) {
    await detector.release();
  }
}

function clearWakeCaptureTimer() {
  if (state.wakeCaptureTimer) {
    window.clearTimeout(state.wakeCaptureTimer);
    state.wakeCaptureTimer = 0;
  }
}

/**
 * @param {string} message
 * @returns {void}
 */
function setWakeStatus(message) {
  els.wakeStatus.textContent = message;
}

/**
 * @param {Blob} blob
 * @returns {Promise<{ assistantAudioStarted: boolean }>}
 */
async function submitAudio(blob) {
  const settings = readSettings();
  validateApiBaseUrl(settings.baseUrl);
  const mimeType = normalizeAudioType(blob.type || preferredMimeType());
  const requestId = `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const url = buildApiUrl(
    settings.baseUrl,
    `/api/transports/${encodeURIComponent(settings.transportId)}/audio-turns`,
    { wait: "true" },
  );
  const headers = {
    "content-type": mimeType,
    "x-request-id": requestId,
    "x-chat-id": settings.chatId,
    "x-sender-id": settings.senderId,
    "x-sender-name": settings.senderName,
    "x-timestamp": new Date().toISOString(),
  };

  setBusy(true);
  setStatus("Uploading", `Uploading ${formatBytes(blob.size)} as ${mimeType}.`);
  writeDiagnostics({ request: { url, requestId, mimeType, bytes: blob.size } });

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: blob,
    });
    const raw = await response.text();
    const body = parseJsonOrText(raw);
    writeDiagnostics({ request: { url, requestId, mimeType, bytes: blob.size }, response: body });
    if (!response.ok) {
      throw new Error(formatHttpError(response.status, raw));
    }
    return await renderAssistantResponse(settings, body);
  } finally {
    setBusy(false);
  }
}

/**
 * @param {string} type
 * @returns {string}
 */
function normalizeAudioType(type) {
  const trimmed = type.trim();
  return trimmed.toLowerCase().startsWith("audio/") ? trimmed : "audio/webm";
}

/**
 * @param {string} baseUrl
 * @returns {void}
 */
function validateApiBaseUrl(baseUrl) {
  if (!baseUrl) {
    throw new Error("Enter an API base URL.");
  }
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("Enter a valid API base URL.");
  }
  if (location.protocol === "https:" && url.protocol !== "https:" && !isLoopbackUrl(baseUrl)) {
    throw new Error("Use an HTTPS API base URL from this deployed page.");
  }
}

/**
 * @param {string} baseUrl
 * @param {string} apiPath
 * @param {Record<string, string>} [searchParams]
 * @returns {string}
 */
function buildApiUrl(baseUrl, apiPath, searchParams = {}) {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, "");
  const path = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
  url.pathname = `${basePath}${path}`;
  for (const [key, value] of Object.entries(searchParams)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

/**
 * @param {number} status
 * @param {string} body
 * @returns {string}
 */
function formatHttpError(status, body) {
  if (status === 401) {
    return "Unauthorized. Open the client with a tokenized API URL.";
  }
  return `HTTP ${status}: ${body}`;
}

/**
 * @param {typeof DEFAULT_SETTINGS} settings
 * @param {unknown} responseBody
 * @returns {Promise<{ assistantAudioStarted: boolean }>}
 */
async function renderAssistantResponse(settings, responseBody) {
  if (!isRecord(responseBody)) {
    throw new Error("Response was not a JSON object.");
  }
  const text = typeof responseBody.text === "string" ? responseBody.text : "";
  els.assistantText.textContent = text || "Assistant returned no text.";

  const audio = isRecord(responseBody.audio) ? responseBody.audio : null;
  if (!audio) {
    setStatus("Done", "Assistant returned text but no audio.");
    return { assistantAudioStarted: false };
  }

  const audioUrl = resolveAudioUrl(settings.baseUrl, audio);
  setStatus("Playing", "Downloading assistant audio.");
  const audioResponse = await fetch(audioUrl);
  if (!audioResponse.ok) {
    throw new Error(`Audio download failed with HTTP ${audioResponse.status}.`);
  }
  const audioBlob = await audioResponse.blob();
  if (state.assistantAudioUrl) {
    URL.revokeObjectURL(state.assistantAudioUrl);
  }
  state.assistantAudioUrl = URL.createObjectURL(audioBlob);
  els.assistantAudio.src = state.assistantAudioUrl;
  let assistantAudioStarted = false;
  try {
    await els.assistantAudio.play();
    assistantAudioStarted = true;
  } catch {
    assistantAudioStarted = false;
  }
  setStatus("Done", "Assistant response is ready.");
  return { assistantAudioStarted };
}

/**
 * @param {string} baseUrl
 * @param {Record<string, unknown>} audio
 * @returns {string}
 */
function resolveAudioUrl(baseUrl, audio) {
  if (typeof audio.path === "string" && audio.path.trim()) {
    return buildApiUrl(baseUrl, `/api/media/${encodeURIComponent(audio.path.trim())}`);
  }
  if (typeof audio.url === "string" && audio.url.trim()) {
    const url = new URL(audio.url, baseUrl);
    const base = new URL(baseUrl);
    for (const [key, value] of base.searchParams) {
      if (!url.searchParams.has(key)) {
        url.searchParams.set(key, value);
      }
    }
    return url.toString();
  }
  throw new Error("Response audio did not include a path or URL.");
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function renderDuration() {
  if (!state.recordingStartedAt) {
    els.duration.textContent = "00:00.0";
    return;
  }
  const elapsed = Math.max(0, performance.now() - state.recordingStartedAt);
  els.duration.textContent = formatDuration(elapsed);
}

function stopTimer() {
  window.clearInterval(state.timer);
  state.timer = 0;
  state.recordingStartedAt = 0;
  renderDuration();
}

/**
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
  const totalTenths = Math.floor(ms / 100);
  const minutes = Math.floor(totalTenths / 600);
  const seconds = Math.floor((totalTenths % 600) / 10);
  const tenths = totalTenths % 10;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths}`;
}

/**
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kib = bytes / 1024;
  if (kib < 1024) {
    return `${kib.toFixed(1)} KiB`;
  }
  return `${(kib / 1024).toFixed(2)} MiB`;
}

/**
 * @param {string} label
 * @param {string} message
 * @param {"recording" | "error" | ""} [tone]
 * @returns {void}
 */
function setStatus(label, message, tone = "") {
  els.statePill.textContent = label;
  els.statePill.classList.toggle("recording", tone === "recording");
  els.statePill.classList.toggle("error", tone === "error");
  els.statusText.textContent = message;
}

/**
 * @param {boolean} value
 * @returns {void}
 */
function setBusy(value) {
  if (value) {
    state.busyCount += 1;
  } else {
    state.busyCount = Math.max(0, state.busyCount - 1);
  }
  state.busy = state.busyCount > 0;
  renderControls();
}

function renderControls() {
  const isRecording = state.recorder !== null && state.recorder.state === "recording";
  const isWakeCapturing = state.wakeRecorder !== null || state.wakeTriggered;
  const isWakeArmed = state.wakeListening || state.wakeTriggered || state.wakeAutoRestart;
  const isCaptureActive = isRecording || isWakeCapturing;
  const captureSupported = isSecureContext
    && Boolean(navigator.mediaDevices?.getUserMedia)
    && typeof MediaRecorder !== "undefined";
  const wakeSupported = localWakeSupported();
  els.enableMic.disabled = state.busy || isCaptureActive || isWakeArmed || !captureSupported;
  els.startRecording.disabled = state.busy || isCaptureActive || isWakeArmed || !captureSupported;
  els.stopSend.disabled = state.busy || !isRecording;
  els.discardRecording.disabled = state.busy || !isRecording;
  els.startListening.disabled = state.busy || isCaptureActive || isWakeArmed || !wakeSupported;
  els.stopListening.disabled = !isWakeArmed;
  els.wakePhrase.disabled = isWakeArmed || isCaptureActive;
  els.wakeThreshold.disabled = isWakeArmed || isCaptureActive;
  els.wakeCaptureSeconds.disabled = isWakeArmed || isCaptureActive;
  els.wakeSilenceSeconds.disabled = isWakeArmed || isCaptureActive;
}

/**
 * @param {unknown} error
 * @returns {void}
 */
function handleError(error) {
  const message = errorMessage(error);
  setStatus("Error", message, "error");
  writeDiagnostics({ error: message });
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
}

/**
 * @param {string} message
 * @returns {void}
 */
function throwAndShow(message) {
  handleError(new Error(message));
}

/**
 * @param {string} raw
 * @returns {unknown}
 */
function parseJsonOrText(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * @param {unknown} payload
 * @returns {void}
 */
function writeDiagnostics(payload) {
  els.diagnostics.textContent = JSON.stringify(payload, null, 2);
}

/**
 * @param {unknown} payload
 * @returns {void}
 */
function appendDiagnostics(payload) {
  state.diagnosticsHistory.push({
    at: new Date().toISOString(),
    payload,
  });
  if (state.diagnosticsHistory.length > 20) {
    state.diagnosticsHistory.splice(0, state.diagnosticsHistory.length - 20);
  }
  writeDiagnostics({ events: state.diagnosticsHistory });
}

function cleanup() {
  void stopWakeListening("");
  if (state.assistantAudioUrl) {
    URL.revokeObjectURL(state.assistantAudioUrl);
    state.assistantAudioUrl = "";
  }
  releaseMicrophone();
}

function releaseMicrophone() {
  if (state.stream) {
    state.stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
  }
}
