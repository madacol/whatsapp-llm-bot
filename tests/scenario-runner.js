import { setTimeout as delay } from "node:timers/promises";

/**
 * @typedef {(ctx: ScenarioContext) => void | Promise<void>} ScenarioStep
 *
 * @typedef {{
 *   current: unknown,
 *   sentMessages: Array<{ id: string, chatId: string, message: Record<string, unknown> }>,
 *   state: Map<string, unknown>,
 *   set: (name: string, value: unknown) => void,
 *   get: (name: string) => unknown,
 *   setResult: (name: string, value: unknown) => void,
 *   result: (name: string) => unknown,
 *   cleanup: (fn: () => void | Promise<void>) => void,
 *   waitFor: (predicate: () => boolean, failureMessage: string, timeoutMs?: number) => Promise<void>,
 * }} ScenarioContext
 */

/**
 * Run a vertical scenario as a plain list of JavaScript steps.
 * @param {ScenarioStep[]} steps
 * @param {{ name?: string }} [options]
 * @returns {Promise<ScenarioContext>}
 */
export async function runScenario(steps, options = {}) {
  const ctx = createScenarioContext();
  const scenarioName = options.name ?? "scenario";
  /** @type {Array<{ index: number, name: string, status: "running" | "done" | "failed" }>} */
  const stepLog = [];

  try {
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      if (typeof step !== "function") {
        throw new TypeError(`Expected scenario step ${index + 1} to be a function.`);
      }
      const name = getStepName(step, index);
      /** @type {{ index: number, name: string, status: "running" | "done" | "failed" }} */
      const logEntry = { index, name, status: "running" };
      stepLog.push(logEntry);
      try {
        await step(ctx);
        logEntry.status = "done";
      } catch (error) {
        logEntry.status = "failed";
        throw buildStepError({ scenarioName, index, total: steps.length, name, error, ctx });
      }
    }
    return ctx;
  } finally {
    ctx.set("scenario.stepLog", stepLog);
    await runCleanups(ctx);
  }
}

/**
 * Create a named scenario step without introducing a builder DSL.
 * @param {string} name
 * @param {ScenarioStep} run
 * @returns {ScenarioStep}
 */
export function scenarioStep(name, run) {
  Object.defineProperty(run, "name", {
    value: name,
    configurable: true,
  });
  return run;
}

/**
 * @returns {ScenarioContext}
 */
function createScenarioContext() {
  /** @type {Map<string, unknown>} */
  const state = new Map();
  /** @type {Map<string, unknown>} */
  const results = new Map();
  /** @type {Array<() => void | Promise<void>>} */
  const cleanups = [];
  state.set("scenario.cleanups", cleanups);

  return {
    current: null,
    sentMessages: [],
    state,
    set(name, value) {
      state.set(name, value);
    },
    get(name) {
      return state.get(name);
    },
    setResult(name, value) {
      results.set(name, value);
    },
    result(name) {
      if (!results.has(name)) {
        throw new Error(`Scenario result "${name}" has not been set.`);
      }
      return results.get(name);
    },
    cleanup(fn) {
      cleanups.push(fn);
    },
    waitFor(predicate, failureMessage, timeoutMs = 1_000) {
      return waitForCondition(predicate, failureMessage, timeoutMs);
    },
  };
}

/**
 * @param {ScenarioStep} step
 * @param {number} index
 * @returns {string}
 */
function getStepName(step, index) {
  return step.name || `step-${index + 1}`;
}

/**
 * @param {{
 *   scenarioName: string,
 *   index: number,
 *   total: number,
 *   name: string,
 *   error: unknown,
 *   ctx: ScenarioContext,
 * }} input
 * @returns {Error}
 */
function buildStepError({ scenarioName, index, total, name, error, ctx }) {
  const message = error instanceof Error ? error.message : String(error);
  const currentSummary = summarizeCurrent(ctx.current);
  const wrapped = new Error(
    `${scenarioName} failed at step ${index + 1}/${total} (${name}): ${message}${currentSummary}`,
    { cause: error },
  );
  if (error instanceof Error && error.stack) {
    wrapped.stack = `${wrapped.stack}\nCaused by: ${error.stack}`;
  }
  return wrapped;
}

/**
 * @param {unknown} current
 * @returns {string}
 */
function summarizeCurrent(current) {
  if (current === null || current === undefined) {
    return "";
  }
  if (typeof current !== "object") {
    return `; current=${String(current)}`;
  }
  const record = /** @type {Record<string, unknown>} */ (current);
  const event = typeof record.event === "string" ? record.event : null;
  const seam = typeof record.seam === "string" ? record.seam : null;
  if (seam || event) {
    return `; current=${[seam, event].filter(Boolean).join(":")}`;
  }
  return `; currentKeys=${Object.keys(record).slice(0, 8).join(",")}`;
}

/**
 * @param {ScenarioContext} ctx
 * @returns {Promise<void>}
 */
async function runCleanups(ctx) {
  const cleanups = ctx.get("scenario.cleanups");
  if (!Array.isArray(cleanups)) {
    return;
  }
  for (let index = cleanups.length - 1; index >= 0; index -= 1) {
    const cleanup = cleanups[index];
    if (typeof cleanup === "function") {
      await cleanup();
    }
  }
}

/**
 * @param {() => boolean} predicate
 * @param {string} failureMessage
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
async function waitForCondition(predicate, failureMessage, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await delay(10);
  }
  throw new Error(failureMessage);
}
