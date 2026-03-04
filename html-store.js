import crypto from "node:crypto";
import config from "./config.js";

/**
 * Ensure the html_pages table exists.
 * @param {PGlite} db
 */
async function ensureSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS html_pages (
      id UUID PRIMARY KEY,
      html TEXT NOT NULL,
      title TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

/** @type {WeakSet<PGlite>} */
const initialized = new WeakSet();

/**
 * Lazy-init schema (once per db instance).
 * @param {PGlite} db
 */
async function init(db) {
  if (initialized.has(db)) return;
  await ensureSchema(db);
  initialized.add(db);
}

/**
 * Store an HTML page and return its UUID.
 * @param {PGlite} db
 * @param {string} html
 * @param {string} [title]
 * @returns {Promise<string>} The UUID of the stored page
 */
export async function storePage(db, html, title) {
  await init(db);
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO html_pages (id, html, title) VALUES ($1, $2, $3)`,
    [id, html, title ?? null],
  );
  return id;
}

/**
 * Store an HTML page and return a display link (with optional title prefix).
 * @param {PGlite} db
 * @param {HtmlContent} htmlContent
 * @returns {Promise<string>} Link text like "Title: http://…/page/uuid" or just the URL
 */
export async function storeAndLinkHtml(db, htmlContent) {
  const pageId = await storePage(db, htmlContent.html, htmlContent.title);
  const baseUrl = config.html_server_base_url || `http://localhost:${config.html_server_port}`;
  const pageUrl = `${baseUrl}/page/${pageId}`;
  return htmlContent.title ? `${htmlContent.title}: ${pageUrl}` : pageUrl;
}

/**
 * Retrieve an HTML page by UUID.
 * @param {PGlite} db
 * @param {string} id
 * @returns {Promise<{html: string, title?: string} | null>}
 */
export async function getPage(db, id) {
  await init(db);
  const { rows } = await db.query(
    `SELECT html, title FROM html_pages WHERE id = $1`,
    [id],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  /** @type {{html: string, title?: string}} */
  const result = { html: /** @type {string} */ (row.html) };
  if (row.title) result.title = /** @type {string} */ (row.title);
  return result;
}
