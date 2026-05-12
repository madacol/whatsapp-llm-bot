import { createServer } from "node:http";
import { getPage } from "./html-store.js";
import { createLogger } from "./logger.js";
import { getChatDb } from "./db.js";
import { ensureChatStoreSchema } from "./store/schema/chat.js";

const log = createLogger("html-server");

/** @type {import("node:http").Server | null} */
let server = null;

/**
 * Start the HTML page server.
 * @param {number} port - Port to listen on (0 for OS-assigned)
 * @param {PGlite} [legacyDb] Optional legacy root DB for old /page/:id links.
 * @returns {Promise<number>} The actual port the server is listening on
 */
export async function startHtmlServer(port, legacyDb) {
  server = createServer(async (req, res) => {
    const legacyMatch = req.url?.match(/^\/page\/([0-9a-f-]{36})$/);
    if (legacyMatch && legacyDb) {
      const page = await getPage(legacyDb, legacyMatch[1]);
      if (!page) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
        return;
      }
      respondWithPage(res, page);
      return;
    }

    const match = req.url?.match(/^\/chat\/([^/]+)\/page\/([0-9a-f-]{36})$/);
    if (!match) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    const chatId = decodeURIComponent(match[1]);
    const db = getChatDb(chatId);
    await ensureChatStoreSchema(db);
    const page = await getPage(db, match[2]);
    if (!page) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    respondWithPage(res, page);
  });

  const s = server;
  await new Promise((resolve) => s.listen(port, "0.0.0.0", () => resolve(undefined)));
  const addr = s.address();
  const assignedPort = typeof addr === "object" && addr ? addr.port : port;
  log.info(`listening on port ${assignedPort}`);
  return assignedPort;
}

/**
 * @param {import("node:http").ServerResponse} res
 * @param {{ html: string, title?: string }} page
 * @returns {void}
 */
function respondWithPage(res, page) {
  const escapedTitle = page.title
    ? page.title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    : "";
  const titleTag = escapedTitle ? `<title>${escapedTitle}</title>` : "";
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">${titleTag}</head><body>${page.html}</body></html>`;
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
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
