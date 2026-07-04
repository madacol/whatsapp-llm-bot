import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT_ROOT = fileURLToPath(new URL("./", import.meta.url));
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4173;

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
 * @param {{ root?: string }} [options]
 * @returns {import("node:http").Server}
 */
export function createWebAudioClientServer(options = {}) {
  const root = options.root ?? CLIENT_ROOT;
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
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
 * @returns {{ host: string, port: number }}
 */
function parseArgs(argv) {
  let host = process.env.WEB_AUDIO_HOST || DEFAULT_HOST;
  let port = Number.parseInt(process.env.PORT || process.env.WEB_AUDIO_PORT || String(DEFAULT_PORT), 10);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--host" && next) {
      host = next;
      index += 1;
    } else if (arg === "--port" && next) {
      port = Number.parseInt(next, 10);
      index += 1;
    }
  }

  return {
    host,
    port: Number.isInteger(port) && port >= 0 ? port : DEFAULT_PORT,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { host, port } = parseArgs(process.argv.slice(2));
  const server = createWebAudioClientServer();
  server.listen(port, host, () => {
    const address = server.address();
    const assignedPort = typeof address === "object" && address ? address.port : port;
    console.log(`Web audio client listening at http://${host}:${assignedPort}`);
  });
}
