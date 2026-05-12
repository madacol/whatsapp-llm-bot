import { createServer } from "node:http";
import { getPage } from "./html-store.js";
import { createLogger } from "./logger.js";

const log = createLogger("html-server");

/** @type {import("node:http").Server | null} */
let server = null;

/**
 * Start the HTML page server.
 * @param {number} port - Port to listen on (0 for OS-assigned)
 * @returns {Promise<number>} The actual port the server is listening on
 */
export async function startHtmlServer(port) {
  server = createServer(async (req, res) => {
    const match = req.url?.match(/^\/chat\/([^/]+)\/html\/([0-9a-f]{64})\.html$/);
    if (!match) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    const chatId = decodeURIComponent(match[1]);
    const page = await getPage(chatId, match[2]);
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
 * @param {string} page
 * @returns {void}
 */
function respondWithPage(res, page) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(page);
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
