import { getPage } from "../../../html-store.js";

/**
 * @param {Function} action_fn
 */
async function stores_html_file_and_returns_link(action_fn) {
  const result = await action_fn(
    { chatId: "expose-html-test" },
    { html: "<h1>Report</h1>", title: "Report" },
  );

  if (typeof result !== "string" || !result.includes("/chat/expose-html-test/html/")) {
    throw new Error(`Expected page link, got ${String(result)}`);
  }

  const hash = result.match(/\/html\/([0-9a-f]{64})\.html/)?.[1];
  if (!hash) {
    throw new Error(`Expected page hash in link, got ${result}`);
  }

  const html = await getPage("expose-html-test", hash);
  if (!html?.includes("<h1>Report</h1>")) {
    throw new Error(`Expected stored HTML file, got ${html}`);
  }
}

/**
 * @param {Function} action_fn
 */
async function rejects_script_html(action_fn) {
  await assertRejects(
    () => action_fn({ chatId: "expose-html-bad" }, { html: "<script>alert(1)</script>" }),
    "static",
  );
}

/**
 * @param {() => Promise<unknown>} fn
 * @param {string} expected
 */
async function assertRejects(fn, expected) {
  try {
    await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(expected)) {
      throw new Error(`Expected error containing ${expected}, got ${message}`);
    }
    return;
  }
  throw new Error("Expected function to reject.");
}

export default [
  stores_html_file_and_returns_link,
  rejects_script_html,
];
