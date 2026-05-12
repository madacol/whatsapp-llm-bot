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
async function stores_script_html(action_fn) {
  const result = await action_fn(
    { chatId: "expose-html-script" },
    { html: "<button onclick=\"document.body.dataset.clicked='1'\">Run</button><script>document.body.dataset.ready='1'</script>" },
  );
  if (typeof result !== "string") {
    throw new Error(`Expected page link, got ${String(result)}`);
  }
  const hash = result.match(/\/html\/([0-9a-f]{64})\.html/)?.[1];
  if (!hash) {
    throw new Error(`Expected page hash in link, got ${result}`);
  }
  const html = await getPage("expose-html-script", hash);
  if (!html?.includes("<script>document.body.dataset.ready='1'</script>")) {
    throw new Error(`Expected stored script HTML, got ${html}`);
  }
}

export default [
  stores_html_file_and_returns_link,
  stores_script_html,
];
