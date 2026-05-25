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
  refreshButton: document.querySelector("#refreshButton"),
  servers: document.querySelector("#servers"),
  serverCount: document.querySelector("#serverCount"),
  items: document.querySelector("#items"),
  status: document.querySelector("#status"),
  librarySummary: document.querySelector("#librarySummary"),
  searchInput: document.querySelector("#searchInput"),
  typeFilter: document.querySelector("#typeFilter"),
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

function setConnected(connected) {
  els.signedOut.classList.toggle("hidden", connected);
  els.signedIn.classList.toggle("hidden", !connected);
  els.authDescription.textContent = "Connected locally. Your token and library cache are kept in this browser's IndexedDB.";
  els.refreshButton.disabled = !connected;
  els.searchInput.disabled = !connected || !state.items.length;
  els.typeFilter.disabled = !connected || !state.items.length;
  els.copyTitlesButton.disabled = !connected || !state.items.length;
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
  state.servers = await fetchResources(activeToken(), state.clientId);
  state.selectedServer = null;
  await saveServers(state.servers);
  renderServers();

  if (state.servers.length) {
    try {
      await selectServer(state.servers[0]);
    } catch (error) {
      setStatus(`Found ${state.servers.length} server, but could not load its libraries: ${error.message}`);
    }
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
      const button = document.createElement("button");
      button.className = `server-button${serverId(state.selectedServer) === serverId(server) ? " active" : ""}`;
      button.type = "button";
      button.innerHTML = `
        <strong>${escapeHtml(server.name || "Unnamed server")}</strong>
        <span>${escapeHtml(connection?.uri || "No connection")}</span>
      `;
      button.addEventListener("click", () => selectServer(server));
      return button;
    }),
  );
}

async function selectServer(server) {
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
    return;
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
  state.items = allItems.sort((a, b) => a.sortTitle.localeCompare(b.sortTitle));
  await saveLibrarySnapshot({
    generatedAt: new Date().toISOString(),
    serverId: serverId(state.selectedServer),
    serverName: state.selectedServer?.name || "",
    serverUri,
    sections: includedSections,
    items: state.items,
  });
  updateLibraryControls();
  els.librarySummary.textContent = `${state.items.length.toLocaleString()} titles from ${includedSections.length} movie/show libraries.`;
  setStatus("Library loaded and saved in IndexedDB.");
  renderItems();
}

function updateLibraryControls() {
  els.searchInput.disabled = !state.items.length;
  els.typeFilter.disabled = !state.items.length;
  els.copyTitlesButton.disabled = !state.items.length;
}

function renderItems() {
  const filtered = filteredItems();

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
  return state.items.filter((item) => {
    const matchesType = type === "all" || item.type === type;
    const matchesQuery = !query || `${item.title} ${item.year} ${item.library}`.toLowerCase().includes(query);
    return matchesType && matchesQuery;
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
    els.librarySummary.textContent = `${state.items.length.toLocaleString()} cached titles from ${state.sections.length} movie/show libraries.`;
    setStatus(`Loaded cached library from ${new Date(persisted.librarySnapshot.generatedAt).toLocaleString()}.`);
  }

  setConnected(Boolean(state.token));
  renderServers();
  renderItems();

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
els.refreshButton.addEventListener("click", () => loadLibrary().catch((error) => setStatus(error.message)));
els.searchInput.addEventListener("input", renderItems);
els.typeFilter.addEventListener("change", renderItems);
els.copyTitlesButton.addEventListener("click", () => copyTitles().catch((error) => setStatus(error.message)));

initialize().catch((error) => setStatus(error.message));
