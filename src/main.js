import {
  createClientId,
  createPin,
  fetchBrowseItems,
  fetchResources,
  fetchSections,
  pollPin,
} from "./browserPlex.js";
import {
  clearPlexState,
  loadAppState,
  saveClientId,
  saveLibrarySnapshot,
  saveSelectedServerId,
  saveServers,
  saveToken,
} from "./storage.js";

const state = {
  clientId: "",
  token: "",
  servers: [],
  selectedServer: null,
  items: [],
  sections: [],
  polling: null,
};

const excludedLibraryTitles = new Set(["kids movies", "kids tv shows"]);

function isExcludedLibrary(section) {
  return excludedLibraryTitles.has(String(section.title || "").trim().toLowerCase());
}

const els = {
  signInButton: document.querySelector("#signInButton"),
  tokenButton: document.querySelector("#tokenButton"),
  tokenInput: document.querySelector("#tokenInput"),
  signOutButton: document.querySelector("#signOutButton"),
  signedOut: document.querySelector("#signedOut"),
  signedIn: document.querySelector("#signedIn"),
  pinBox: document.querySelector("#pinBox"),
  pinCode: document.querySelector("#pinCode"),
  authLink: document.querySelector("#authLink"),
  authDescription: document.querySelector("#authDescription"),
  servers: document.querySelector("#servers"),
  serverCount: document.querySelector("#serverCount"),
  items: document.querySelector("#items"),
  status: document.querySelector("#status"),
  librarySummary: document.querySelector("#librarySummary"),
  searchInput: document.querySelector("#searchInput"),
  typeFilter: document.querySelector("#typeFilter"),
  movieYearStartFilter: document.querySelector("#movieYearStartFilter"),
  movieYearEndFilter: document.querySelector("#movieYearEndFilter"),
  copyTitlesButton: document.querySelector("#copyTitlesButton"),
};

function setStatus(message) {
  els.status.textContent = message;
}

function activeToken() {
  return state.token || "";
}

function serverId(server) {
  return server?.clientIdentifier || server?.name || "";
}

function itemCacheKey(serverKey, item) {
  return `${serverKey}:${item.id}`;
}

function sortLibraryItems(items) {
  return items.sort((a, b) =>
    String(a.sortTitle || a.title || "").localeCompare(String(b.sortTitle || b.title || "")),
  );
}

function activeLibraryItems() {
  return state.items.filter((item) => !item.missingFromLatestScan);
}

function mergeLibraryItems({ existingItems, freshItems, serverKey, scannedAt }) {
  const existingByKey = new Map(
    existingItems.map((item) => {
      const cacheKey = item.cacheKey || itemCacheKey(serverKey, item);
      return [cacheKey, { ...item, cacheKey }];
    }),
  );
  const freshKeys = new Set();

  const mergedFreshItems = freshItems.map((item) => {
    const cacheKey = itemCacheKey(serverKey, item);
    freshKeys.add(cacheKey);
    return {
      ...(existingByKey.get(cacheKey) || {}),
      ...item,
      cacheKey,
      missingFromLatestScan: false,
      removedAt: "",
    };
  });

  const missingItems = [...existingByKey.values()]
    .filter((item) => !freshKeys.has(item.cacheKey))
    .map((item) => ({
      ...item,
      missingFromLatestScan: true,
      removedAt: item.removedAt || scannedAt,
    }));

  return sortLibraryItems([...mergedFreshItems, ...missingItems]);
}

function setConnected(connected) {
  const hasActiveItems = Boolean(activeLibraryItems().length);
  els.signedOut.classList.toggle("hidden", connected);
  els.signedIn.classList.toggle("hidden", !connected);
  els.authDescription.textContent = "Connected locally. Your token and library cache are kept in this browser's IndexedDB.";
  els.searchInput.disabled = !connected || !hasActiveItems;
  els.typeFilter.disabled = !connected || !hasActiveItems;
  els.movieYearStartFilter.disabled = !connected || !hasActiveItems;
  els.movieYearEndFilter.disabled = !connected || !hasActiveItems;
  els.copyTitlesButton.disabled = !connected || !hasActiveItems;
}

async function startPlexSignIn() {
  clearInterval(state.polling);
  setStatus("Creating Plex sign-in code...");
  const pin = await createPin({ clientId: state.clientId });
  els.pinCode.textContent = pin.code;
  els.authLink.href = pin.authUrl;
  els.pinBox.classList.remove("hidden");
  window.open(pin.authUrl, "_blank", "noopener,noreferrer");
  setStatus("Sign in with Plex, then leave this page open.");

  state.polling = setInterval(async () => {
    try {
      const result = await pollPin({ pinId: pin.id, clientId: state.clientId });
      if (!result.token) return;
      clearInterval(state.polling);
      await useToken(result.token);
    } catch (error) {
      clearInterval(state.polling);
      setStatus(error.message);
    }
  }, 2500);
}

async function useToken(token) {
  state.token = token.trim();
  await saveToken(state.token);
  setConnected(true);
  await loadServers();
}

async function loadServers() {
  setStatus("Loading Plex servers...");
  const selectedId = serverId(state.selectedServer);
  state.servers = await fetchResources(activeToken(), state.clientId);
  state.selectedServer =
    state.servers.find((server) => serverId(server) === selectedId) || state.servers[0] || null;
  await saveServers(state.servers);
  await saveSelectedServerId(serverId(state.selectedServer));
  renderServers();

  if (state.servers.length) {
    setStatus(`Found ${state.servers.length} server${state.servers.length === 1 ? "" : "s"}. Click Reload library to fetch titles.`);
  } else {
    setStatus("No Plex Media Server resources were found for this account.");
  }
}

function bestConnection(server) {
  return orderedConnections(server)[0];
}

function renderServers() {
  els.serverCount.textContent = String(state.servers.length);

  if (!state.servers.length) {
    els.servers.className = "server-list empty";
    els.servers.textContent = state.token ? "No servers found." : "Connect to Plex to load servers.";
    return;
  }

  els.servers.className = "server-list";
  els.servers.replaceChildren(
    ...state.servers.map((server) => {
      const connection = bestConnection(server);
      const isSelected = serverId(state.selectedServer) === serverId(server);
      const row = document.createElement("div");
      row.className = `server-card${isSelected ? " active" : ""}`;
      row.innerHTML = `
        <button class="server-button" type="button">
          <strong>${escapeHtml(server.name || "Unnamed server")}</strong>
          <span>${escapeHtml(connection?.uri || "No connection")}</span>
        </button>
        <button class="server-reload-button" type="button">Reload library</button>
      `;
      row.querySelector(".server-button").addEventListener("click", () => selectServer(server));
      row.querySelector(".server-reload-button").addEventListener("click", () => reloadServerLibrary(server));
      return row;
    }),
  );
}

async function selectServer(server) {
  state.selectedServer = server;
  await saveSelectedServerId(serverId(server));
  renderServers();
  setStatus(`Selected ${server.name || "server"}. Click Reload library to fetch titles.`);
}

async function reloadServerLibrary(server) {
  state.selectedServer = server;
  await saveSelectedServerId(serverId(server));
  renderServers();
  await loadLibrary();
}

function orderedConnections(server) {
  return [...(server.connections || [])].sort((a, b) => {
    const score = (connection) =>
      (connection.local ? 0 : 10) +
      (connection.relay ? 5 : 0) +
      (location.protocol === "https:" && connection.protocol === "http" ? 20 : 0) +
      (connection.protocol === "https" ? 0 : 1);
    return score(a) - score(b);
  });
}

async function loadLibrary() {
  if (!state.selectedServer) {
    await loadServers();
    if (!state.selectedServer) return;
  }

  const token = state.selectedServer.accessToken || activeToken();
  const errors = [];

  setStatus(`Loading libraries from ${state.selectedServer.name}...`);

  for (const connection of orderedConnections(state.selectedServer)) {
    const serverUri = connection.uri.replace(/\/$/, "");
    try {
      const sections = await fetchSections({
        token,
        clientId: state.clientId,
        serverUri,
        excludedTitles: excludedLibraryTitles,
      });

      await loadSectionItems(sections, token, serverUri);
      return;
    } catch (error) {
      errors.push(`${serverUri}: ${error.message}`);
    }
  }

  throw new Error(errors.join(" | "));
}

async function loadSectionItems(sections, token, serverUri) {
  const includedSections = sections.filter((section) => !isExcludedLibrary(section));
  const allItems = [];
  const scannedAt = new Date().toISOString();
  const selectedServerId = serverId(state.selectedServer);
  for (const section of includedSections) {
    setStatus(`Loading ${section.title}...`);
    const items = await fetchBrowseItems({
      token,
      clientId: state.clientId,
      serverUri,
      sectionId: section.id,
    });
    allItems.push(...items.map((item) => ({ ...item, library: section.title })));
  }

  state.sections = includedSections;
  state.items = mergeLibraryItems({
    existingItems: state.items,
    freshItems: allItems,
    serverKey: selectedServerId,
    scannedAt,
  });
  await saveLibrarySnapshot({
    generatedAt: scannedAt,
    serverId: selectedServerId,
    serverName: state.selectedServer?.name || "",
    serverUri,
    sections: includedSections,
    items: state.items,
  });
  updateLibraryControls();
  updateMovieYearFilters();
  const activeItemCount = activeLibraryItems().length;
  els.librarySummary.textContent = `${activeItemCount.toLocaleString()} titles from ${includedSections.length} movie/show libraries.`;
  renderItems({ statusPrefix: "Library loaded and saved in IndexedDB." });
}

function updateLibraryControls() {
  const hasActiveItems = Boolean(activeLibraryItems().length);
  els.searchInput.disabled = !hasActiveItems;
  els.typeFilter.disabled = !hasActiveItems;
  els.movieYearStartFilter.disabled = !hasActiveItems;
  els.movieYearEndFilter.disabled = !hasActiveItems;
  els.copyTitlesButton.disabled = !hasActiveItems;
}

function movieYears() {
  return [
    ...new Set(
      activeLibraryItems()
        .filter((item) => item.type === "movie")
        .map((item) => Number(item.year))
        .filter((year) => Number.isInteger(year)),
    ),
  ].sort((a, b) => a - b);
}

function updateMovieYearFilters() {
  const currentStart = els.movieYearStartFilter.value;
  const currentEnd = els.movieYearEndFilter.value;
  const years = movieYears();
  const options = [
    new Option("Any", ""),
    ...years.map((year) => new Option(String(year), String(year))),
  ];

  els.movieYearStartFilter.replaceChildren(...options.map((option) => option.cloneNode(true)));
  els.movieYearEndFilter.replaceChildren(...options.map((option) => option.cloneNode(true)));

  if (years.includes(Number(currentStart))) els.movieYearStartFilter.value = currentStart;
  if (years.includes(Number(currentEnd))) els.movieYearEndFilter.value = currentEnd;
}

function filteredResultStatus(filteredCount, statusPrefix = "") {
  const resultNoun = filteredCount === 1 ? "result" : "results";
  const message = `${filteredCount.toLocaleString()} ${resultNoun} after filtering.`;
  return statusPrefix ? `${statusPrefix} ${message}` : message;
}

function renderItems({ statusPrefix = "" } = {}) {
  const filtered = filteredItems();

  if (state.items.length) {
    setStatus(filteredResultStatus(filtered.length, statusPrefix));
  }

  if (!filtered.length) {
    els.items.className = "grid empty";
    els.items.textContent = state.items.length ? "No titles match the current filters." : "No titles loaded.";
    return;
  }

  els.items.className = "grid";
  els.items.replaceChildren(
    ...filtered.map((item) => {
      const card = document.createElement("article");
      card.className = "media-card";
      const poster = item.thumb
        ? `<img src="${escapeAttr(item.thumb)}" alt="">`
        : `<span>${item.type === "movie" ? "Movie" : "TV"}</span>`;
      const watched =
        item.type === "show" && item.leafCount
          ? `<span>${Number(item.viewedLeafCount || 0)} / ${Number(item.leafCount)} watched</span>`
          : "";

      card.innerHTML = `
        <div class="poster">${poster}</div>
        <div class="media-info">
          <strong>${escapeHtml(item.title)}</strong>
          <div class="meta">
            <span class="badge ${escapeAttr(item.type)}">${item.type === "movie" ? "Movie" : "TV Show"}</span>
            ${item.year ? `<span>${escapeHtml(String(item.year))}</span>` : ""}
            ${item.library ? `<span>${escapeHtml(item.library)}</span>` : ""}
            ${watched}
          </div>
        </div>
      `;
      return card;
    }),
  );
}

function filteredItems() {
  const query = els.searchInput.value.trim().toLowerCase();
  const type = els.typeFilter.value;
  const movieYearStart = Number(els.movieYearStartFilter.value) || null;
  const movieYearEnd = Number(els.movieYearEndFilter.value) || null;
  return state.items.filter((item) => {
    if (item.missingFromLatestScan) return false;
    const year = Number(item.year);
    const matchesType = type === "all" || item.type === type;
    const matchesQuery = !query || `${item.title} ${item.year} ${item.library}`.toLowerCase().includes(query);
    const matchesMovieYearStart = item.type !== "movie" || !movieYearStart || year >= movieYearStart;
    const matchesMovieYearEnd = item.type !== "movie" || !movieYearEnd || year <= movieYearEnd;
    return matchesType && matchesQuery && matchesMovieYearStart && matchesMovieYearEnd;
  });
}

async function copyTitles() {
  const titles = filteredItems().map((item) => item.title);
  if (!titles.length) {
    setStatus("No titles to copy.");
    return;
  }

  await navigator.clipboard.writeText(titles.join("\n"));
  setStatus(`Copied ${titles.length.toLocaleString()} title${titles.length === 1 ? "" : "s"} to clipboard.`);
}

async function signOut() {
  clearInterval(state.polling);
  await clearPlexState();
  state.token = "";
  state.servers = [];
  state.selectedServer = null;
  state.sections = [];
  state.items = [];
  updateMovieYearFilters();
  els.pinBox.classList.add("hidden");
  els.tokenInput.value = "";
  els.librarySummary.textContent = "No library loaded.";
  setConnected(false);
  renderServers();
  renderItems();
  setStatus("Signed out and cleared Plex data from IndexedDB.");
}

async function initialize() {
  const persisted = await loadAppState();
  state.clientId = persisted.clientId || createClientId();
  if (!persisted.clientId) await saveClientId(state.clientId);

  state.token = persisted.token;
  state.servers = persisted.servers;
  state.selectedServer = state.servers.find((server) => serverId(server) === persisted.selectedServerId) || null;

  if (persisted.librarySnapshot?.items?.length) {
    state.items = persisted.librarySnapshot.items;
    state.sections = persisted.librarySnapshot.sections || [];
    updateMovieYearFilters();
    els.librarySummary.textContent = `${activeLibraryItems().length.toLocaleString()} cached titles from ${state.sections.length} movie/show libraries.`;
  }

  setConnected(Boolean(state.token));
  renderServers();
  renderItems({
    statusPrefix: persisted.librarySnapshot?.items?.length
      ? `Loaded cached library from ${new Date(persisted.librarySnapshot.generatedAt).toLocaleString()}.`
      : "",
  });

  if (state.token && !state.items.length) {
    await loadServers();
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}

els.signInButton.addEventListener("click", () => {
  startPlexSignIn().catch((error) => setStatus(error.message));
});

els.tokenButton.addEventListener("click", () => {
  if (!els.tokenInput.value.trim()) {
    setStatus("Paste a Plex token first.");
    return;
  }
  useToken(els.tokenInput.value).catch((error) => setStatus(error.message));
});

els.signOutButton.addEventListener("click", () => {
  signOut().catch((error) => setStatus(error.message));
});
els.searchInput.addEventListener("input", renderItems);
els.typeFilter.addEventListener("change", renderItems);
els.movieYearStartFilter.addEventListener("change", renderItems);
els.movieYearEndFilter.addEventListener("change", renderItems);
els.copyTitlesButton.addEventListener("click", () => copyTitles().catch((error) => setStatus(error.message)));

initialize().catch((error) => setStatus(error.message));
