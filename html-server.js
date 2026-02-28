import { createServer } from "node:http";
import { getPage } from "./html-store.js";
import { createLogger } from "./logger.js";

const log = createLogger("html-server");

/** @type {import("node:http").Server | null} */
let server = null;

/**
 * Start the HTML page server.
 * @param {number} port - Port to listen on (0 for OS-assigned)
 * @param {PGlite} db - Database instance for page lookups
 * @returns {Promise<number>} The actual port the server is listening on
 */
export async function startHtmlServer(port, db) {
  server = createServer(async (req, res) => {
    const match = req.url?.match(/^\/page\/([0-9a-f-]{36})$/);
    if (!match) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    const page = await getPage(db, match[1]);
    if (!page) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    const escapedTitle = page.title
      ? page.title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      : "";
    const titleTag = escapedTitle ? `<title>${escapedTitle}</title>` : "";
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">${titleTag}</head><body>${page.html}</body></html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });

  const s = server;
  await new Promise((resolve) => s.listen(port, "0.0.0.0", () => resolve(undefined)));
  const addr = s.address();
  const assignedPort = typeof addr === "object" && addr ? addr.port : port;
  log.info(`listening on port ${assignedPort}`);
  return assignedPort;
}

/**
 * Stop the HTML page server.
 * @returns {Promise<void>}
 */
export async function stopHtmlServer() {
  if (!server) return;
  const s = server;
  server = null;
  await new Promise((resolve) => s.close(() => resolve(undefined)));
}
