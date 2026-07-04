const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 1280;
const MEL_CONTEXT_SAMPLES = 160 * 3;
const MELSPEC_MAX_ROWS = 10 * 97;
const FEATURE_MAX_ROWS = 120;
const PREDICTION_BUFFER_ROWS = 30;
const MODEL_INPUT_FRAMES = 16;
const FEATURE_COLUMNS = 96;
const MELSPEC_COLUMNS = 32;
const WARMUP_PREDICTIONS = 5;

/**
 * @typedef {{
 *   data: Float32Array | BigInt64Array | BigUint64Array | Int32Array | Uint8Array;
 *   dims: number[];
 * }} OrtTensorLike
 *
 * @typedef {{
 *   inputNames: string[];
 *   outputNames: string[];
 *   run(feeds: Record<string, OrtTensorLike>): Promise<Record<string, OrtTensorLike>>;
 *   release(): Promise<void>;
 * }} OrtSessionLike
 *
 * @typedef {{
 *   Tensor: new (type: "float32", data: Float32Array, dims: number[]) => OrtTensorLike;
 *   InferenceSession: {
 *     create(path: string, options?: Record<string, unknown>): Promise<OrtSessionLike>;
 *   };
 *   env?: {
 *     wasm?: {
 *       wasmPaths?: string | Record<string, string>;
 *       numThreads?: number;
 *       proxy?: boolean;
 *     };
 *   };
 * }} OrtLike
 *
 * @typedef {{
 *   detected: boolean;
 *   label: string;
 *   score: number;
 *   threshold: number;
 * }} WakePrediction
 */

export const OPEN_WAKE_WORD_MODEL_BASE_PATH = "./vendor/openwakeword/";

export class OpenWakeWordJarvisDetector {
  sampleRate = SAMPLE_RATE;
  frameLength = FRAME_SAMPLES;

  /**
   * @param {{
   *   ort: OrtLike;
   *   melspecSession: OrtSessionLike;
   *   embeddingSession: OrtSessionLike;
   *   wakeSession: OrtSessionLike;
   *   threshold: number;
   * }} options
   */
  constructor(options) {
    this.ort = options.ort;
    this.melspecSession = options.melspecSession;
    this.embeddingSession = options.embeddingSession;
    this.wakeSession = options.wakeSession;
    this.threshold = options.threshold;
    /** @type {number[]} */
    this.rawDataBuffer = [];
    /** @type {Int16Array} */
    this.rawDataRemainder = new Int16Array(0);
    this.accumulatedSamples = 0;
    /** @type {number[][]} */
    this.melspectrogramRows = initialRows(76, MELSPEC_COLUMNS, 1);
    /** @type {number[][]} */
    this.featureRows = [];
    /** @type {number[][]} */
    this.primedFeatureRows = [];
    /** @type {number[]} */
    this.predictionBuffer = [];
  }

  /**
   * @param {OrtLike} ort
   * @param {{ modelBasePath?: string, threshold: number }} options
   * @returns {Promise<OpenWakeWordJarvisDetector>}
   */
  static async create(ort, options) {
    const modelBasePath = options.modelBasePath || OPEN_WAKE_WORD_MODEL_BASE_PATH;
    const sessionOptions = {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    };
    const [melspecSession, embeddingSession, wakeSession] = await Promise.all([
      ort.InferenceSession.create(`${modelBasePath}melspectrogram.onnx`, sessionOptions),
      ort.InferenceSession.create(`${modelBasePath}embedding_model.onnx`, sessionOptions),
      ort.InferenceSession.create(`${modelBasePath}hey_jarvis_v0.1.onnx`, sessionOptions),
    ]);
    const detector = new OpenWakeWordJarvisDetector({
      ort,
      melspecSession,
      embeddingSession,
      wakeSession,
      threshold: options.threshold,
    });
    await detector.primeFeatureBuffer();
    detector.captureResetBaseline();
    return detector;
  }

  /**
   * @returns {Promise<void>}
   */
  async release() {
    await Promise.all([
      this.melspecSession.release(),
      this.embeddingSession.release(),
      this.wakeSession.release(),
    ]);
  }

  reset() {
    this.rawDataBuffer = [];
    this.rawDataRemainder = new Int16Array(0);
    this.accumulatedSamples = 0;
    this.melspectrogramRows = initialRows(76, MELSPEC_COLUMNS, 1);
    this.featureRows = cloneRows(this.primedFeatureRows);
    this.predictionBuffer = [];
  }

  /**
   * @param {Int16Array} frame
   * @returns {Promise<WakePrediction>}
   */
  async process(frame) {
    const preparedSamples = await this.prepareFeatures(frame);
    let score = 0;
    if (preparedSamples > FRAME_SAMPLES) {
      const predictions = [];
      for (let index = Math.floor(preparedSamples / FRAME_SAMPLES) - 1; index >= 0; index -= 1) {
        predictions.push(await this.predictFromFeatures(-MODEL_INPUT_FRAMES - index));
      }
      score = Math.max(...predictions);
    } else if (preparedSamples === FRAME_SAMPLES) {
      score = await this.predictFromFeatures();
    } else if (this.predictionBuffer.length > 0) {
      score = this.predictionBuffer[this.predictionBuffer.length - 1] ?? 0;
    }

    if (this.predictionBuffer.length < WARMUP_PREDICTIONS) {
      score = 0;
    }
    this.predictionBuffer.push(score);
    trimNumericArray(this.predictionBuffer, PREDICTION_BUFFER_ROWS);
    return {
      detected: score >= this.threshold,
      label: "hey_jarvis",
      score,
      threshold: this.threshold,
    };
  }

  /**
   * @returns {Promise<void>}
   */
  async primeFeatureBuffer() {
    const samples = new Int16Array(SAMPLE_RATE * 4);
    let seed = 0x12345678;
    for (let index = 0; index < samples.length; index += 1) {
      seed = (1664525 * seed + 1013904223) >>> 0;
      samples[index] = ((seed / 0xffffffff) * 2000 - 1000) | 0;
    }
    const embeddings = await this.embeddingsForSamples(samples);
    this.featureRows.push(...embeddings);
    trimRows(this.featureRows, FEATURE_MAX_ROWS);
  }

  captureResetBaseline() {
    this.primedFeatureRows = cloneRows(this.featureRows);
  }

  /**
   * @param {Int16Array} input
   * @returns {Promise<number>}
   */
  async prepareFeatures(input) {
    let x = input;
    if (this.rawDataRemainder.length > 0) {
      x = concatenateInt16(this.rawDataRemainder, input);
      this.rawDataRemainder = new Int16Array(0);
    }

    if (this.accumulatedSamples + x.length >= FRAME_SAMPLES) {
      const remainder = (this.accumulatedSamples + x.length) % FRAME_SAMPLES;
      const evenLength = remainder === 0 ? x.length : x.length - remainder;
      if (evenLength > 0) {
        this.bufferRawData(x.subarray(0, evenLength));
        this.accumulatedSamples += evenLength;
      }
      this.rawDataRemainder = remainder === 0 ? new Int16Array(0) : x.slice(evenLength);
    } else {
      this.bufferRawData(x);
      this.accumulatedSamples += x.length;
    }

    let processedSamples = 0;
    if (this.accumulatedSamples >= FRAME_SAMPLES && this.accumulatedSamples % FRAME_SAMPLES === 0) {
      await this.streamingMelspectrogram(this.accumulatedSamples);
      const preparedFrames = Math.floor(this.accumulatedSamples / FRAME_SAMPLES);
      for (let frameIndex = preparedFrames - 1; frameIndex >= 0; frameIndex -= 1) {
        const offsetRows = frameIndex === 0 ? 0 : 8 * frameIndex;
        const end = offsetRows === 0 ? this.melspectrogramRows.length : this.melspectrogramRows.length - offsetRows;
        const start = end - 76;
        if (start >= 0 && end <= this.melspectrogramRows.length) {
          const windowRows = this.melspectrogramRows.slice(start, end);
          this.featureRows.push(...await this.embeddingsForMelspecWindows([windowRows]));
        }
      }
      processedSamples = this.accumulatedSamples;
      this.accumulatedSamples = 0;
      trimRows(this.featureRows, FEATURE_MAX_ROWS);
    }
    return processedSamples || this.accumulatedSamples;
  }

  /**
   * @param {Int16Array} samples
   * @returns {void}
   */
  bufferRawData(samples) {
    for (const sample of samples) {
      this.rawDataBuffer.push(sample);
    }
    trimNumericArray(this.rawDataBuffer, SAMPLE_RATE * 10);
  }

  /**
   * @param {number} sampleCount
   * @returns {Promise<void>}
   */
  async streamingMelspectrogram(sampleCount) {
    if (this.rawDataBuffer.length < 400) {
      throw new Error("openWakeWord needs at least 25 ms of PCM before feature extraction.");
    }
    const start = Math.max(0, this.rawDataBuffer.length - sampleCount - MEL_CONTEXT_SAMPLES);
    const samples = Int16Array.from(this.rawDataBuffer.slice(start));
    const rows = await this.melspectrogramForSamples(samples);
    this.melspectrogramRows.push(...rows);
    trimRows(this.melspectrogramRows, MELSPEC_MAX_ROWS);
  }

  /**
   * @param {Int16Array} samples
   * @returns {Promise<number[][]>}
   */
  async embeddingsForSamples(samples) {
    const melspecRows = await this.melspectrogramForSamples(samples);
    /** @type {number[][][]} */
    const windows = [];
    for (let index = 0; index < melspecRows.length; index += 8) {
      const windowRows = melspecRows.slice(index, index + 76);
      if (windowRows.length === 76) {
        windows.push(windowRows);
      }
    }
    return this.embeddingsForMelspecWindows(windows);
  }

  /**
   * @param {Int16Array} samples
   * @returns {Promise<number[][]>}
   */
  async melspectrogramForSamples(samples) {
    const input = new Float32Array(samples.length);
    for (let index = 0; index < samples.length; index += 1) {
      input[index] = samples[index] ?? 0;
    }
    const output = await runSession(
      this.melspecSession,
      new this.ort.Tensor("float32", input, [1, input.length]),
    );
    const dims = output.dims;
    const rowCount = dims[dims.length - 2] ?? 0;
    const data = /** @type {Float32Array} */ (output.data);
    /** @type {number[][]} */
    const rows = [];
    for (let row = 0; row < rowCount; row += 1) {
      const values = [];
      for (let column = 0; column < MELSPEC_COLUMNS; column += 1) {
        values.push((data[row * MELSPEC_COLUMNS + column] ?? 0) / 10 + 2);
      }
      rows.push(values);
    }
    return rows;
  }

  /**
   * @param {number[][][]} windows
   * @returns {Promise<number[][]>}
   */
  async embeddingsForMelspecWindows(windows) {
    if (windows.length === 0) {
      return [];
    }
    const input = new Float32Array(windows.length * 76 * MELSPEC_COLUMNS);
    let cursor = 0;
    for (const windowRows of windows) {
      for (const row of windowRows) {
        for (const value of row) {
          input[cursor] = value;
          cursor += 1;
        }
      }
    }
    const output = await runSession(
      this.embeddingSession,
      new this.ort.Tensor("float32", input, [windows.length, 76, MELSPEC_COLUMNS, 1]),
    );
    const data = /** @type {Float32Array} */ (output.data);
    /** @type {number[][]} */
    const rows = [];
    for (let batch = 0; batch < windows.length; batch += 1) {
      const row = [];
      for (let column = 0; column < FEATURE_COLUMNS; column += 1) {
        row.push(data[batch * FEATURE_COLUMNS + column] ?? 0);
      }
      rows.push(row);
    }
    return rows;
  }

  /**
   * @param {number} [startIndex]
   * @returns {Promise<number>}
   */
  async predictFromFeatures(startIndex) {
    const rows = this.getFeatureWindow(MODEL_INPUT_FRAMES, startIndex);
    const input = new Float32Array(MODEL_INPUT_FRAMES * FEATURE_COLUMNS);
    let cursor = 0;
    for (const row of rows) {
      for (const value of row) {
        input[cursor] = value;
        cursor += 1;
      }
    }
    const output = await runSession(
      this.wakeSession,
      new this.ort.Tensor("float32", input, [1, MODEL_INPUT_FRAMES, FEATURE_COLUMNS]),
    );
    return Number(output.data[0] ?? 0);
  }

  /**
   * @param {number} count
   * @param {number} [startIndex]
   * @returns {number[][]}
   */
  getFeatureWindow(count, startIndex) {
    if (startIndex === undefined) {
      return this.featureRows.slice(-count);
    }
    const start = startIndex < 0 ? this.featureRows.length + startIndex : startIndex;
    const rawEnd = startIndex + count === 0
      ? this.featureRows.length
      : startIndex < 0
        ? this.featureRows.length + startIndex + count
        : startIndex + count;
    return this.featureRows.slice(start, rawEnd);
  }
}

/**
 * @param {OrtSessionLike} session
 * @param {OrtTensorLike} input
 * @returns {Promise<OrtTensorLike>}
 */
async function runSession(session, input) {
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  if (!inputName || !outputName) {
    throw new Error("ONNX model did not expose input/output names.");
  }
  const outputs = await session.run({ [inputName]: input });
  const output = outputs[outputName];
  if (!output || !(output.data instanceof Float32Array)) {
    throw new Error("ONNX model returned an unexpected output tensor.");
  }
  return output;
}

/**
 * @param {number} rows
 * @param {number} columns
 * @param {number} value
 * @returns {number[][]}
 */
function initialRows(rows, columns, value) {
  return Array.from({ length: rows }, () => Array.from({ length: columns }, () => value));
}

/**
 * @param {Int16Array} first
 * @param {Int16Array} second
 * @returns {Int16Array}
 */
function concatenateInt16(first, second) {
  const combined = new Int16Array(first.length + second.length);
  combined.set(first, 0);
  combined.set(second, first.length);
  return combined;
}

/**
 * @param {number[]} values
 * @param {number} maxLength
 * @returns {void}
 */
function trimNumericArray(values, maxLength) {
  if (values.length > maxLength) {
    values.splice(0, values.length - maxLength);
  }
}

/**
 * @param {number[][]} rows
 * @param {number} maxLength
 * @returns {void}
 */
function trimRows(rows, maxLength) {
  if (rows.length > maxLength) {
    rows.splice(0, rows.length - maxLength);
  }
}

/**
 * @param {number[][]} rows
 * @returns {number[][]}
 */
function cloneRows(rows) {
  return rows.map((row) => [...row]);
}
