export const APP_NAME = "Plex Library Browser";
export const PRODUCT_VERSION = "0.1.0";
export const DEFAULT_PAGE_SIZE = 200;
export const POSTER_THUMB_WIDTH = 300;
export const POSTER_THUMB_HEIGHT = 450;

export function createClientId(prefix = "plex-lib") {
  const suffix = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
  return `${prefix}-${suffix}`;
}

export function createPlexHeaders({
  token = "",
  clientId,
  platform = "Web",
  device = "Static Browser",
  deviceName = APP_NAME,
} = {}) {
  const headers = {
    Accept: "application/json",
    "X-Plex-Product": APP_NAME,
    "X-Plex-Version": PRODUCT_VERSION,
    "X-Plex-Client-Identifier": clientId,
    "X-Plex-Platform": platform,
    "X-Plex-Device": device,
    "X-Plex-Device-Name": deviceName,
    "X-Plex-Language": "en",
  };

  if (token) headers["X-Plex-Token"] = token;
  return headers;
}

export async function plexFetch(url, options = {}) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    throw new Error(`Plex request failed for ${url}: ${error.message}`);
  }

  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("json") ? await response.json() : await response.text();

  if (!response.ok) {
    const message = typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300);
    throw new Error(`Plex request failed (${response.status}) for ${url}: ${message}`);
  }

  return body;
}

export function mediaContainer(body) {
  return body?.MediaContainer || body;
}

export function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function decodeXml(value) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function attr(xml, name) {
  const match = xml.match(new RegExp(`${name}="([^"]*)"`, "i"));
  return match ? decodeXml(match[1]) : "";
}

function parseResourceXml(xml) {
  const resources = [];
  const resourceRegex = /<Device\b([^>]*)>([\s\S]*?)<\/Device>/gi;
  let resourceMatch;

  while ((resourceMatch = resourceRegex.exec(xml))) {
    const resourceAttrs = resourceMatch[1];
    const body = resourceMatch[2];
    const connections = [];
    const connectionRegex = /<Connection\b([\s\S]*?)\/>/gi;
    let connectionMatch;

    while ((connectionMatch = connectionRegex.exec(body))) {
      connections.push({
        uri: attr(connectionMatch[1], "uri"),
        address: attr(connectionMatch[1], "address"),
        port: attr(connectionMatch[1], "port"),
        protocol: attr(connectionMatch[1], "protocol"),
        local: attr(connectionMatch[1], "local") === "1",
        relay: attr(connectionMatch[1], "relay") === "1",
      });
    }

    resources.push({
      name: attr(resourceAttrs, "name"),
      product: attr(resourceAttrs, "product"),
      provides: attr(resourceAttrs, "provides"),
      clientIdentifier: attr(resourceAttrs, "clientIdentifier"),
      owned: attr(resourceAttrs, "owned") === "1",
      accessToken: attr(resourceAttrs, "accessToken"),
      connections,
    });
  }

  return resources;
}

export function normalizeResources(body, { fallbackToken = "" } = {}) {
  const rawResources = typeof body === "string" ? parseResourceXml(body) : body;
  const resources = Array.isArray(rawResources) ? rawResources : asArray(mediaContainer(rawResources)?.Device);

  return resources
    .filter((resource) => String(resource.provides || "").includes("server"))
    .map((resource) => {
      const connections = Array.isArray(resource.connections)
        ? resource.connections
        : Array.isArray(resource.Connection)
          ? resource.Connection
          : [];

      return {
        name: resource.name,
        product: resource.product,
        provides: resource.provides,
        clientIdentifier: resource.clientIdentifier,
        owned: Boolean(resource.owned === true || resource.owned === "1"),
        accessToken: resource.accessToken || fallbackToken,
        connections: connections.map((connection) => ({
          uri: connection.uri,
          address: connection.address,
          port: connection.port,
          protocol: connection.protocol,
          local: Boolean(connection.local === true || connection.local === "1"),
          relay: Boolean(connection.relay === true || connection.relay === "1"),
        })),
      };
    })
    .filter((resource) => resource.connections.length);
}

export function normalizeSections(body, { excludedTitles = new Set(), sectionId = "" } = {}) {
  return asArray(mediaContainer(body)?.Directory)
    .filter((section) => section.type === "movie" || section.type === "show")
    .filter((section) => !sectionId || String(section.key) === sectionId)
    .filter((section) => !excludedTitles.has(String(section.title || "").trim().toLowerCase()))
    .map((section) => ({
      id: String(section.key),
      key: section.key,
      title: section.title,
      type: section.type,
      count: Number(section.count || 0),
    }));
}

export function externalGuid(item, source) {
  const prefix = `${source}://`;
  const guid = String(item.guid || "");
  if (guid.startsWith(prefix)) return guid.slice(prefix.length);

  return (
    asArray(item.Guid)
      .map((entry) => String(entry.id || ""))
      .find((id) => id.startsWith(prefix))
      ?.slice(prefix.length) || ""
  );
}

export function posterThumbnailUrl(serverUri, thumbPath, token) {
  if (!thumbPath) return "";

  const endpoint = new URL("/photo/:/transcode", serverUri);
  endpoint.searchParams.set("width", String(POSTER_THUMB_WIDTH));
  endpoint.searchParams.set("height", String(POSTER_THUMB_HEIGHT));
  endpoint.searchParams.set("minSize", "1");
  endpoint.searchParams.set("upscale", "0");
  endpoint.searchParams.set("url", thumbPath);
  endpoint.searchParams.set("X-Plex-Token", token);
  return endpoint.toString();
}

export function normalizeTags(tags) {
  return asArray(tags)
    .map((tag) => {
      if (tag && typeof tag === "object") return tag.tag || tag.title || tag.name || "";
      return tag;
    })
    .map((tag) => String(tag || "").trim())
    .filter(Boolean);
}

export function normalizeBrowseItems(body, serverUri, token) {
  return asArray(mediaContainer(body)?.Metadata).map((item) => ({
    id: String(item.ratingKey || item.key || item.guid || item.title),
    type: item.type,
    title: item.title,
    sortTitle: item.titleSort || item.title,
    guid: item.guid || "",
    genre: normalizeTags(item.Genre).join(", "),
    genres: normalizeTags(item.Genre),
    imdbId: externalGuid(item, "imdb"),
    tmdbId: externalGuid(item, "tmdb"),
    tvdbId: externalGuid(item, "tvdb"),
    year: item.year || "",
    summary: item.summary || "",
    contentRating: item.contentRating || "",
    rating: item.audienceRating || item.rating || "",
    addedAt: item.addedAt || "",
    updatedAt: item.updatedAt || "",
    leafCount: item.leafCount || "",
    viewedLeafCount: item.viewedLeafCount || "",
    thumb: posterThumbnailUrl(serverUri, item.thumb, token),
    art: item.art ? `${serverUri}${item.art}?X-Plex-Token=${encodeURIComponent(token)}` : "",
  }));
}

export async function createPin({ clientId }) {
  const pin = await plexFetch("https://plex.tv/api/v2/pins?strong=true", {
    method: "POST",
    headers: createPlexHeaders({ clientId }),
  });

  return {
    id: pin.id,
    code: pin.code,
    clientId,
    authUrl: `https://app.plex.tv/auth/#!?clientID=${encodeURIComponent(clientId)}&code=${encodeURIComponent(pin.code)}&context%5Bdevice%5D%5Bproduct%5D=${encodeURIComponent(APP_NAME)}`,
  };
}

export async function pollPin({ pinId, clientId }) {
  const pin = await plexFetch(`https://plex.tv/api/v2/pins/${pinId}`, {
    headers: createPlexHeaders({ clientId }),
  });
  return { token: pin.authToken || null, expiresAt: pin.expiresAt || null };
}

export async function fetchResources(token, clientId) {
  return normalizeResources(
    await plexFetch("https://plex.tv/api/resources?includeHttps=1&includeRelay=1", {
      headers: createPlexHeaders({ token, clientId }),
    }),
    { fallbackToken: token },
  );
}

export async function fetchSections({ serverUri, token, clientId, excludedTitles, sectionId }) {
  return normalizeSections(
    await plexFetch(`${serverUri}/library/sections`, {
      headers: createPlexHeaders({ token, clientId }),
    }),
    { excludedTitles, sectionId },
  );
}

export async function fetchSectionItemPages({ serverUri, token, clientId, sectionId, pageSize = DEFAULT_PAGE_SIZE }) {
  let start = 0;
  let total = Infinity;
  const pages = [];

  while (start < total) {
    const endpoint = new URL(`${serverUri}/library/sections/${encodeURIComponent(sectionId)}/all`);
    endpoint.searchParams.set("includeGuids", "1");
    endpoint.searchParams.set("X-Plex-Container-Start", String(start));
    endpoint.searchParams.set("X-Plex-Container-Size", String(pageSize));

    const body = await plexFetch(endpoint, {
      headers: createPlexHeaders({ token, clientId }),
    });
    const page = asArray(mediaContainer(body)?.Metadata);
    pages.push({ body, items: page });

    total = Number(mediaContainer(body)?.totalSize || mediaContainer(body)?.size || 0);
    if (!page.length) break;
    start += page.length;
  }

  return pages;
}

export async function fetchBrowseItems({ serverUri, token, clientId, sectionId, pageSize = DEFAULT_PAGE_SIZE }) {
  const pages = await fetchSectionItemPages({ serverUri, token, clientId, sectionId, pageSize });
  return pages.flatMap((page) => normalizeBrowseItems(page.body, serverUri, token));
}
