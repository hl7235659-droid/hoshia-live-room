import { createServer as createHttpServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cookieStatus, searchQqMusic, resolveQqMusic, validateCookie } from "./qqmusic.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");

export function createServer(options = {}) {
  const cookieFile = options.cookieFile || process.env.QQMUSIC_COOKIE_FILE || "/app/private/cookies.txt";
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Number(options.timeoutMs || process.env.QQMUSIC_TIMEOUT_MS || 12000);

  return createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
      if (req.method === "OPTIONS") return sendJson(res, 204, {});

      if (req.method === "GET" && url.pathname === "/") {
        const html = await readFile(join(PUBLIC_DIR, "index.html"), "utf8");
        return send(res, 200, html, "text/html; charset=utf-8");
      }

      if (req.method === "GET" && url.pathname === "/healthz") {
        return sendJson(res, 200, { ok: true, service: "qqmusic-resolver" });
      }

      if (req.method === "GET" && url.pathname === "/auth/status") {
        return sendJson(res, 200, { ok: true, ...cookieStatus(await readCookie(cookieFile)) });
      }

      if (req.method === "POST" && url.pathname === "/auth/cookie") {
        const body = await readJson(req);
        const validation = validateCookie(body.cookie);
        if (!validation.ok) return sendJson(res, 400, { ok: false, error: validation.error });
        await mkdir(dirname(cookieFile), { recursive: true });
        await writeFile(cookieFile, validation.cookie, { encoding: "utf8", mode: 0o600 });
        return sendJson(res, 200, { ok: true, ...cookieStatus(validation.cookie) });
      }

      if (req.method === "GET" && url.pathname === "/search") {
        const query = url.searchParams.get("q") || url.searchParams.get("keyword") || "";
        const page = Number(url.searchParams.get("page") || 1);
        const limit = Number(url.searchParams.get("limit") || 20);
        const result = await searchQqMusic({ query, page, limit, cookie: await readCookie(cookieFile), fetchImpl, timeoutMs });
        return sendJson(res, result.success ? 200 : 400, result);
      }

      if (req.method === "POST" && url.pathname === "/resolve") {
        const body = await readJson(req);
        const result = await resolveQqMusic({ item: body.item || body, quality: body.quality || "vip", cookie: await readCookie(cookieFile), fetchImpl, timeoutMs });
        return sendJson(res, result.success ? 200 : 400, result);
      }

      return sendJson(res, 404, { ok: false, error: "not_found" });
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: safeError(error) });
    }
  });
}

export async function readCookie(cookieFile) {
  try {
    return (await readFile(cookieFile, "utf8")).trim();
  } catch {
    return "";
  }
}

async function readJson(req) {
  const text = await readBody(req);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const params = new URLSearchParams(text);
    return Object.fromEntries(params.entries());
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 60000) {
        reject(new Error("body_too_large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendJson(res, status, value) {
  return send(res, status, JSON.stringify(value), "application/json; charset=utf-8");
}

function send(res, status, body, contentType) {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  res.end(body);
}

function safeError(error) {
  const message = String(error?.message || error || "request_failed");
  if (message.includes("abort")) return "qqmusic_timeout";
  if (message.includes("body_too_large")) return "body_too_large";
  return "qqmusic_request_failed";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 8190);
  const host = process.env.HOST || "0.0.0.0";
  createServer().listen(port, host, () => {
    console.log(`qqmusic-resolver listening on ${host}:${port}`);
  });
}
