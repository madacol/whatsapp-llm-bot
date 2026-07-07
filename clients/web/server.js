import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT_ROOT = fileURLToPath(new URL("./", import.meta.url));
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4173;
const DEFAULT_API_TARGET = "http://127.0.0.1:3200";
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"],
]);

/**
 * @param {string} filePath
 * @returns {string}
 */
export function contentTypeForPath(filePath) {
  return CONTENT_TYPES.get(extname(filePath).toLowerCase()) ?? "application/octet-stream";
}

/**
 * @param {string} root
 * @param {string} requestPath
 * @returns {string | null}
 */
export function resolveStaticPath(root, requestPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  const relativePath = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(join(absoluteRoot, relativePath));
  if (absolutePath !== absoluteRoot && !absolutePath.startsWith(`${absoluteRoot}${sep}`)) {
    return null;
  }
  return absolutePath;
}

/**
 * @param {{ root?: string, apiTarget?: string }} [options]
 * @returns {import("node:http").Server}
 */
export function createWebAudioClientServer(options = {}) {
  const root = options.root ?? CLIENT_ROOT;
  const apiTarget = normalizeApiTarget(options.apiTarget ?? process.env.WEB_AUDIO_API_TARGET ?? DEFAULT_API_TARGET);
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (isApiProxyPath(url.pathname)) {
      proxyApiRequest(req, res, apiTarget);
      return;
    }

    const filePath = resolveStaticPath(root, url.pathname);
    if (!filePath) {
      sendNotFound(res);
      return;
    }

    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch {
      sendNotFound(res);
      return;
    }
    if (!fileStat.isFile()) {
      sendNotFound(res);
      return;
    }

    res.writeHead(200, {
      "cache-control": "no-store",
      "content-length": String(fileStat.size),
      "content-type": contentTypeForPath(filePath),
    });
    createReadStream(filePath).pipe(res);
  });
}

/**
 * @param {string} pathname
 * @returns {boolean}
 */
function isApiProxyPath(pathname) {
  return pathname === "/health" || pathname.startsWith("/api/");
}

/**
 * @param {string} value
 * @returns {URL}
 */
function normalizeApiTarget(value) {
  const target = value.includes("://") ? value : `http://${value}`;
  return new URL(target);
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {URL} apiTarget
 * @returns {void}
 */
function proxyApiRequest(req, res, apiTarget) {
  const targetUrl = buildProxyUrl(apiTarget, req.url ?? "/");
  const clientRequest = targetUrl.protocol === "https:" ? httpsRequest : httpRequest;
  const upstream = clientRequest(targetUrl, {
    method: req.method,
    headers: forwardedRequestHeaders(req.headers, targetUrl),
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode ?? 502, forwardedResponseHeaders(upstreamRes.headers));
    upstreamRes.pipe(res);
  });
  upstream.on("error", () => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(502, {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    });
    res.end("Bad gateway");
  });
  req.on("aborted", () => upstream.destroy());
  req.pipe(upstream);
}

/**
 * @param {URL} apiTarget
 * @param {string} requestUrl
 * @returns {URL}
 */
function buildProxyUrl(apiTarget, requestUrl) {
  const incoming = new URL(requestUrl, "http://localhost");
  const targetUrl = new URL(apiTarget.toString());
  const basePath = targetUrl.pathname.replace(/\/+$/, "");
  targetUrl.pathname = `${basePath}${incoming.pathname}`;
  targetUrl.search = incoming.search;
  return targetUrl;
}

/**
 * @param {import("node:http").IncomingHttpHeaders} headers
 * @param {URL} targetUrl
 * @returns {import("node:http").OutgoingHttpHeaders}
 */
function forwardedRequestHeaders(headers, targetUrl) {
  /** @type {import("node:http").OutgoingHttpHeaders} */
  const nextHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      continue;
    }
    nextHeaders[name] = value;
  }
  nextHeaders.host = targetUrl.host;
  return nextHeaders;
}

/**
 * @param {import("node:http").IncomingHttpHeaders} headers
 * @returns {import("node:http").OutgoingHttpHeaders}
 */
function forwardedResponseHeaders(headers) {
  /** @type {import("node:http").OutgoingHttpHeaders} */
  const nextHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      continue;
    }
    nextHeaders[name] = value;
  }
  return nextHeaders;
}

/**
 * @param {import("node:http").ServerResponse} res
 * @returns {void}
 */
function sendNotFound(res) {
  res.writeHead(404, {
    "cache-control": "no-store",
    "content-type": "text/plain; charset=utf-8",
  });
  res.end("Not found");
}

/**
 * @param {string[]} argv
 * @returns {{ host: string, port: number, apiTarget: string }}
 */
function parseArgs(argv) {
  let host = process.env.WEB_AUDIO_HOST || DEFAULT_HOST;
  let port = Number.parseInt(process.env.PORT || process.env.WEB_AUDIO_PORT || String(DEFAULT_PORT), 10);
  let apiTarget = process.env.WEB_AUDIO_API_TARGET || DEFAULT_API_TARGET;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--host" && next) {
      host = next;
      index += 1;
    } else if (arg === "--port" && next) {
      port = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === "--api-target" && next) {
      apiTarget = next;
      index += 1;
    }
  }

  return {
    host,
    port: Number.isInteger(port) && port >= 0 ? port : DEFAULT_PORT,
    apiTarget,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { host, port, apiTarget } = parseArgs(process.argv.slice(2));
  const server = createWebAudioClientServer({ apiTarget });
  server.listen(port, host, () => {
    const address = server.address();
    const assignedPort = typeof address === "object" && address ? address.port : port;
    console.log(`Web audio client listening at http://${host}:${assignedPort}`);
    console.log(`Proxying /api to ${normalizeApiTarget(apiTarget).origin}`);
  });
}
