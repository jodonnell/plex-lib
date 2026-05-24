import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import {
  APP_NAME,
  createClientId,
  createPlexHeaders,
  fetchBrowseItems,
  fetchResources,
  fetchSections,
  plexFetch,
} from "./src/plex.js";

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 4173);
const ROOT = process.cwd();
const configuredToken = process.env.PLEX_API_TOKEN?.trim() || "";
const excludedLibraryTitles = new Set(["kids movies", "kids tv shows"]);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const clientId = createClientId("plex-lib");

function plexHeaders(token) {
  return createPlexHeaders({ token, clientId });
}

function resolveToken(token) {
  return token?.trim() || configuredToken;
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function handleApi(req, res, url) {
  try {
    if (req.method === "GET" && url.pathname === "/api/config") {
      sendJson(res, 200, { clientId, appName: APP_NAME, hasConfiguredToken: Boolean(configuredToken) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/pin") {
      const pin = await plexFetch("https://plex.tv/api/v2/pins?strong=true", {
        method: "POST",
        headers: plexHeaders(),
      });
      sendJson(res, 200, {
        id: pin.id,
        code: pin.code,
        clientId,
        authUrl: `https://app.plex.tv/auth/#!?clientID=${encodeURIComponent(clientId)}&code=${encodeURIComponent(pin.code)}&context%5Bdevice%5D%5Bproduct%5D=${encodeURIComponent(APP_NAME)}`,
      });
      return;
    }

    const pinMatch = url.pathname.match(/^\/api\/pin\/(\d+)$/);
    if (req.method === "GET" && pinMatch) {
      const pin = await plexFetch(`https://plex.tv/api/v2/pins/${pinMatch[1]}`, {
        headers: plexHeaders(),
      });
      sendJson(res, 200, { token: pin.authToken || null, expiresAt: pin.expiresAt || null });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/resources") {
      const { token: requestToken } = await readJson(req);
      const token = resolveToken(requestToken);
      if (!token) throw new Error("Missing Plex token.");
      sendJson(res, 200, { servers: await fetchResources(token, plexHeaders) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/sections") {
      const { token: requestToken, serverUri } = await readJson(req);
      const token = resolveToken(requestToken);
      if (!token || !serverUri) throw new Error("Missing Plex token or server URI.");
      const sections = await fetchSections({
        serverUri,
        token,
        headersForToken: plexHeaders,
        excludedTitles: excludedLibraryTitles,
      });
      sendJson(res, 200, { sections });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/items") {
      const { token: requestToken, serverUri, sectionId } = await readJson(req);
      const token = resolveToken(requestToken);
      if (!token || !serverUri || !sectionId) throw new Error("Missing Plex token, server URI, or section ID.");

      const items = await fetchBrowseItems({ serverUri, token, sectionId, headersForToken: plexHeaders });
      sendJson(res, 200, { items });
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

async function serveStatic(req, res, url) {
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const path = normalize(join(ROOT, "public", requested));
  const publicRoot = normalize(join(ROOT, "public"));

  if (!path.startsWith(publicRoot)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const content = await readFile(path);
    res.writeHead(200, { "Content-Type": mimeTypes[extname(path)] || "application/octet-stream" });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) {
    await handleApi(req, res, url);
    return;
  }
  await serveStatic(req, res, url);
});

server.listen(PORT, HOST, () => {
  console.log(`Plex Library Browser is running at http://${HOST}:${PORT}`);
});
