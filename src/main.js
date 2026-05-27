import {
  createClientId,
  createPin,
  fetchBrowseItems,
  fetchResources,
  fetchSections,
  pollPin,
  POSTER_THUMB_HEIGHT,
  POSTER_THUMB_WIDTH,
} from "./browserPlex.js";
import {
  clearPlexState,
  loadAppState,
  saveClientId,
  saveLibrarySnapshot,
  saveOmdbApiKey,
  saveSelectedServerId,
  saveServers,
  saveToken,
} from "./storage.js";

const state = {
  clientId: "",
  token: "",
  omdbApiKey: "",
  servers: [],
  selectedServer: null,
  items: [],
  sections: [],
  polling: null,
  filters: null,
};

const excludedLibraryTitles = new Set(["kids movies", "kids tv shows"]);
const filterStorageKey = "plex-lib:library-filters";
const defaultFilters = {
  query: "",
  type: "all",
  movieYearStart: "",
  movieYearEnd: "",
  metacriticStart: "",
  metacriticEnd: "",
  genres: [],
};

function isExcludedLibrary(section) {
  return excludedLibraryTitles.has(String(section.title || "").trim().toLowerCase());
}

const els = {
  signInButton: document.querySelector("#signInButton"),
  tokenButton: document.querySelector("#tokenButton"),
  tokenInput: document.querySelector("#tokenInput"),
  omdbApiKeyButton: document.querySelector("#omdbApiKeyButton"),
  omdbApiKeyInput: document.querySelector("#omdbApiKeyInput"),
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
  metacriticStartFilter: document.querySelector("#metacriticStartFilter"),
  metacriticEndFilter: document.querySelector("#metacriticEndFilter"),
  genreFilter: document.querySelector("#genreFilter"),
  genreFilterCount: document.querySelector("#genreFilterCount"),
  genreClearButton: document.querySelector("#genreClearButton"),
  genreOptions: document.querySelector("#genreOptions"),
  copyTitlesButton: document.querySelector("#copyTitlesButton"),
  logCriticScoreButton: document.querySelector("#logCriticScoreButton"),
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

function posterImageUrl(thumb) {
  if (!thumb) return "";

  try {
    const url = new URL(thumb);
    if (url.pathname === "/photo/:/transcode") return thumb;

    const token = url.searchParams.get("X-Plex-Token") || activeToken();
    if (!token) return thumb;

    const endpoint = new URL("/photo/:/transcode", url.origin);
    endpoint.searchParams.set("width", String(POSTER_THUMB_WIDTH));
    endpoint.searchParams.set("height", String(POSTER_THUMB_HEIGHT));
    endpoint.searchParams.set("minSize", "1");
    endpoint.searchParams.set("upscale", "0");
    endpoint.searchParams.set("url", url.pathname);
    endpoint.searchParams.set("X-Plex-Token", token);
    return endpoint.toString();
  } catch {
    return thumb;
  }
}

function activeLibraryItems() {
  return state.items.filter((item) => !item.missingFromLatestScan);
}

function loadSavedFilters() {
  try {
    const saved = JSON.parse(localStorage.getItem(filterStorageKey) || "null");
    if (!saved || typeof saved !== "object") return { ...defaultFilters };

    return {
      query: typeof saved.query === "string" ? saved.query : defaultFilters.query,
      type: ["all", "movie", "show"].includes(saved.type) ? saved.type : defaultFilters.type,
      movieYearStart: typeof saved.movieYearStart === "string" ? saved.movieYearStart : defaultFilters.movieYearStart,
      movieYearEnd: typeof saved.movieYearEnd === "string" ? saved.movieYearEnd : defaultFilters.movieYearEnd,
      metacriticStart: typeof saved.metacriticStart === "string" ? saved.metacriticStart : defaultFilters.metacriticStart,
      metacriticEnd: typeof saved.metacriticEnd === "string" ? saved.metacriticEnd : defaultFilters.metacriticEnd,
      genres: Array.isArray(saved.genres) ? saved.genres.filter((genre) => typeof genre === "string") : [],
    };
  } catch {
    return { ...defaultFilters };
  }
}

function selectOptionIfAvailable(select, value) {
  if ([...select.options].some((option) => option.value === value)) {
    select.value = value;
  }
}

function applySavedFilters() {
  const filters = state.filters || defaultFilters;

  els.searchInput.value = filters.query;
  selectOptionIfAvailable(els.typeFilter, filters.type);
  selectOptionIfAvailable(els.movieYearStartFilter, filters.movieYearStart);
  selectOptionIfAvailable(els.movieYearEndFilter, filters.movieYearEnd);
  selectOptionIfAvailable(els.metacriticStartFilter, filters.metacriticStart);
  selectOptionIfAvailable(els.metacriticEndFilter, filters.metacriticEnd);

  const genres = new Set(filters.genres);
  els.genreOptions.querySelectorAll("input[type='checkbox']").forEach((input) => {
    input.checked = genres.has(input.value);
  });
  updateGenreFilterSummary();
}

function currentFilters() {
  return {
    query: els.searchInput.value,
    type: els.typeFilter.value,
    movieYearStart: els.movieYearStartFilter.value,
    movieYearEnd: els.movieYearEndFilter.value,
    metacriticStart: els.metacriticStartFilter.value,
    metacriticEnd: els.metacriticEndFilter.value,
    genres: selectedGenres(),
  };
}

function saveFilters() {
  state.filters = currentFilters();
  try {
    localStorage.setItem(filterStorageKey, JSON.stringify(state.filters));
  } catch {
    // Keep the in-memory value for this page if localStorage is unavailable.
  }
}

function saveFiltersAndRender() {
  saveFilters();
  renderItems();
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
  els.metacriticStartFilter.disabled = !connected || !hasActiveItems;
  els.metacriticEndFilter.disabled = !connected || !hasActiveItems;
  setGenreFilterDisabled(!connected || !hasActiveItems);
  els.copyTitlesButton.disabled = !connected || !hasActiveItems;
  els.logCriticScoreButton.disabled = !connected || !hasActiveItems;
}

function setGenreFilterDisabled(disabled) {
  els.genreFilter.classList.toggle("is-disabled", disabled);
  els.genreFilter.setAttribute("aria-disabled", String(disabled));
  if (disabled) els.genreFilter.open = false;
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

async function saveOmdbKey() {
  state.omdbApiKey = els.omdbApiKeyInput.value.trim();
  await saveOmdbApiKey(state.omdbApiKey);
  els.omdbApiKeyInput.value = state.omdbApiKey;
  setStatus(state.omdbApiKey ? "Saved OMDb API key in IndexedDB." : "Cleared OMDb API key.");
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
  updateMetacriticFilters();
  updateGenreFilters();
  applySavedFilters();
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
  els.metacriticStartFilter.disabled = !hasActiveItems;
  els.metacriticEndFilter.disabled = !hasActiveItems;
  setGenreFilterDisabled(!hasActiveItems);
  els.copyTitlesButton.disabled = !hasActiveItems;
  els.logCriticScoreButton.disabled = !hasActiveItems;
}

function itemGenres(item) {
  if (Array.isArray(item.genres)) {
    return item.genres.map((genre) => String(genre || "").trim()).filter(Boolean);
  }

  return String(item.genre || "")
    .split(",")
    .map((genre) => genre.trim())
    .filter(Boolean);
}

function availableGenres() {
  return [...new Set(activeLibraryItems().flatMap(itemGenres))].sort((a, b) => a.localeCompare(b));
}

function selectedGenres() {
  return [...els.genreOptions.querySelectorAll("input[type='checkbox']:checked")].map((input) => input.value);
}

function updateGenreFilterSummary() {
  const count = selectedGenres().length;
  els.genreFilterCount.textContent = count ? String(count) : "Any";
}

function updateGenreFilters() {
  const selected = new Set(state.filters?.genres || selectedGenres());
  const genres = availableGenres();

  els.genreOptions.replaceChildren(
    ...genres.map((genre) => {
      const label = document.createElement("label");
      label.className = "genre-option";

      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = genre;
      input.checked = selected.has(genre);

      const text = document.createElement("span");
      text.textContent = genre;

      label.replaceChildren(input, text);
      return label;
    }),
  );
  updateGenreFilterSummary();
}

function clearGenreFilters() {
  els.genreOptions.querySelectorAll("input[type='checkbox']:checked").forEach((input) => {
    input.checked = false;
  });
  updateGenreFilterSummary();
  saveFilters();
  renderItems();
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

function updateMetacriticFilters() {
  const currentStart = els.metacriticStartFilter.value;
  const currentEnd = els.metacriticEndFilter.value;
  const scores = Array.from({ length: 101 }, (_, score) => score);
  const options = [
    new Option("Any", ""),
    ...scores.map((score) => new Option(String(score), String(score))),
  ];

  els.metacriticStartFilter.replaceChildren(...options.map((option) => option.cloneNode(true)));
  els.metacriticEndFilter.replaceChildren(...options.map((option) => option.cloneNode(true)));

  if (scores.includes(Number(currentStart))) els.metacriticStartFilter.value = currentStart;
  if (scores.includes(Number(currentEnd))) els.metacriticEndFilter.value = currentEnd;
}

function filteredResultStatus(filteredCount, statusPrefix = "") {
  const resultNoun = filteredCount === 1 ? "result" : "results";
  const message = `${filteredCount.toLocaleString()} ${resultNoun} after filtering.`;
  return statusPrefix ? `${statusPrefix} ${message}` : message;
}

function optionalNumber(value) {
  return value === "" ? null : Number(value);
}

function formatRatingScore(score, suffix = "") {
  const number = Number.parseFloat(score);
  if (Number.isFinite(number)) return `${Math.round(number)}${suffix}`;
  return "";
}

function ratingSourceKey(source) {
  const normalized = String(source || "")
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/g, "");

  if (["internetmoviedatabase", "imdb", "imdbrating"].includes(normalized)) return "imdb";
  if (["rottentomatoes", "rt", "tomatometer", "tomatometerallcritics"].includes(normalized)) return "rt";
  if (["metacritic", "mc", "metascore"].includes(normalized)) return "metacritic";
  return "";
}

function normalizedRatingFields(item) {
  const fields = [
    item.plexLib?.ratings,
    item.plexLib?.Ratings,
    item.plexLib?.Rating,
    item.ratings,
    item.Ratings,
    item.Rating,
  ].filter(Boolean);

  return fields.flatMap(ratingEntries).reduce((ratings, [source, rawValue]) => {
    const key = ratingSourceKey(source);
    const value = Number.parseFloat(rawValue);
    if (!key || !Number.isFinite(value)) return ratings;

    ratings[key] = key === "imdb" && value <= 10 ? value * 10 : value;
    return ratings;
  }, {});
}

function ratingEntries(fields) {
  if (Array.isArray(fields)) {
    return fields.flatMap((rating) => ratingEntries(rating));
  }

  if (!fields || typeof fields !== "object") return [];

  if ("Source" in fields || "source" in fields || "provider" in fields || "image" in fields || "type" in fields) {
    return [
      [
        fields.Source || fields.source || fields.provider || fields.image || fields.type,
        fields.Value || fields.value || fields.score || fields.rating,
      ],
    ];
  }

  return Object.entries(fields);
}

function itemRatings(item) {
  const ratings = normalizedRatingFields(item);
  const entries = [
    ["IMDb", formatRatingScore(ratings.imdb)],
    ["RT", formatRatingScore(ratings.rt, "%")],
    ["MC", formatRatingScore(ratings.metacritic)],
  ].filter(([, value]) => value);

  const plexRating = Number(item.rating);
  if (Number.isFinite(plexRating) && !entries.length) {
    entries.push(["Rating", `${Math.round(plexRating * 10)}`]);
  }

  return entries;
}

function metacriticScore(item) {
  const score = normalizedRatingFields(item).metacritic;
  return Number.isFinite(score) ? score : null;
}

function renderRatingBadges(item) {
  const ratings = itemRatings(item);
  if (!ratings.length) return "";

  return `
    <div class="ratings" aria-label="Ratings">
      ${ratings
        .map(
          ([label, value]) => `
            <span class="rating">
              <span>${escapeHtml(label)}</span>
              <strong>${escapeHtml(value)}</strong>
            </span>
          `,
        )
        .join("")}
    </div>
  `;
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
      const posterUrl = posterImageUrl(item.thumb);
      const poster = posterUrl
        ? `<img src="${escapeAttr(posterUrl)}" alt="" loading="lazy" decoding="async">`
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
          ${renderRatingBadges(item)}
          <button class="media-log-button" type="button">Log row</button>
        </div>
      `;
      card.querySelector(".media-log-button").addEventListener("click", () => console.log(item));
      return card;
    }),
  );
}

function filteredItems() {
  const query = els.searchInput.value.trim().toLowerCase();
  const type = els.typeFilter.value;
  const movieYearStart = optionalNumber(els.movieYearStartFilter.value);
  const movieYearEnd = optionalNumber(els.movieYearEndFilter.value);
  const metacriticStart = optionalNumber(els.metacriticStartFilter.value);
  const metacriticEnd = optionalNumber(els.metacriticEndFilter.value);
  const genres = selectedGenres();
  return state.items.filter((item) => {
    if (item.missingFromLatestScan) return false;
    const year = Number(item.year);
    const metacritic = metacriticScore(item);
    const itemGenreSet = new Set(itemGenres(item));
    const matchesType = type === "all" || item.type === type;
    const matchesQuery = !query || `${item.title} ${item.year} ${item.library}`.toLowerCase().includes(query);
    const matchesGenres = !genres.length || genres.some((genre) => itemGenreSet.has(genre));
    const matchesMovieYearStart = item.type !== "movie" || movieYearStart === null || year >= movieYearStart;
    const matchesMovieYearEnd = item.type !== "movie" || movieYearEnd === null || year <= movieYearEnd;
    const matchesMetacriticStart = metacriticStart === null || (metacritic !== null && metacritic >= metacriticStart);
    const matchesMetacriticEnd = metacriticEnd === null || (metacritic !== null && metacritic <= metacriticEnd);
    return (
      matchesType &&
      matchesQuery &&
      matchesGenres &&
      matchesMovieYearStart &&
      matchesMovieYearEnd &&
      matchesMetacriticStart &&
      matchesMetacriticEnd
    );
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

async function fetchOmdbMetadata(item) {
  const endpoint = new URL("https://www.omdbapi.com/");
  endpoint.searchParams.set("apikey", state.omdbApiKey);
  endpoint.searchParams.set("plot", "short");

  if (item.imdbId) {
    endpoint.searchParams.set("i", item.imdbId);
  } else {
    endpoint.searchParams.set("t", item.title);
    if (item.year) endpoint.searchParams.set("y", item.year);
  }

  const response = await fetch(endpoint);
  const metadata = await response.json();

  if (response.ok && metadata.Response === "False" && metadata.Error === "Movie not found!") {
    return metadata;
  }

  if (!response.ok || metadata.Response === "False") {
    throw new Error(metadata.Error || `OMDb request failed with status ${response.status}.`);
  }

  return metadata;
}

function normalizeOmdbRatings(ratings) {
  if (!Array.isArray(ratings)) return {};

  return ratings.reduce((normalized, rating) => {
    const source = String(rating.Source || "").toLowerCase();
    const value = String(rating.Value || "");
    const score = Number.parseFloat(value);

    if (Number.isNaN(score)) return normalized;

    if (source === "internet movie database") {
      normalized.imdb = Math.round(score * 10);
    } else if (source === "rotten tomatoes") {
      normalized.rt = Math.round(score);
    } else if (source === "metacritic") {
      normalized.metacritic = Math.round(score);
    }

    return normalized;
  }, {});
}

async function saveCurrentLibrarySnapshot() {
  await saveLibrarySnapshot({
    generatedAt: new Date().toISOString(),
    serverId: serverId(state.selectedServer),
    serverName: state.selectedServer?.name || "",
    sections: state.sections,
    items: state.items,
  });
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function hasPlexLibRatings(item) {
  return Boolean(item.plexLib?.ratings);
}

async function fetchOmdbReviews() {
  const items = filteredItems();

  if (!state.omdbApiKey) {
    setStatus("Save an OMDb API key first.");
    return;
  }

  if (!items.length) {
    setStatus("No title to look up.");
    return;
  }

  let fetchedCount = 0;
  let skippedCount = 0;

  els.logCriticScoreButton.disabled = true;

  try {
    for (const item of items) {
      if (hasPlexLibRatings(item)) {
        skippedCount += 1;
        continue;
      }

      const itemIndex = state.items.findIndex(
        (candidate) => item === candidate || (item.cacheKey && candidate.cacheKey === item.cacheKey),
      );
      if (itemIndex < 0) continue;

      setStatus(`Fetching OMDb reviews for ${item.title} (${fetchedCount + 1} fetched, ${skippedCount} skipped)...`);

      try {
        const metadata = await fetchOmdbMetadata(item);
        state.items[itemIndex] = {
          ...item,
          plexLib: {
            ...(item.plexLib || {}),
            ratings: normalizeOmdbRatings(metadata.Ratings),
          },
        };
        fetchedCount += 1;
        await saveCurrentLibrarySnapshot();
        renderItems({
          statusPrefix: `Saved OMDb reviews for ${state.items[itemIndex].title}. ${fetchedCount} fetched, ${skippedCount} skipped.`,
        });
      } catch (error) {
        setStatus(
          `Stopped fetching OMDb reviews after ${fetchedCount} fetched and ${skippedCount} skipped. ${item.title}: ${error.message}`,
        );
        return;
      }

      await delay(1000);
    }

    setStatus(`Finished fetching OMDb reviews. ${fetchedCount} fetched, ${skippedCount} skipped.`);
  } finally {
    setConnected(Boolean(state.token));
  }
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
  updateMetacriticFilters();
  updateGenreFilters();
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
  state.filters = loadSavedFilters();
  state.clientId = persisted.clientId || createClientId();
  if (!persisted.clientId) await saveClientId(state.clientId);

  state.token = persisted.token;
  state.omdbApiKey = persisted.omdbApiKey;
  state.servers = persisted.servers;
  state.selectedServer = state.servers.find((server) => serverId(server) === persisted.selectedServerId) || null;
  els.omdbApiKeyInput.value = state.omdbApiKey;

  if (persisted.librarySnapshot?.items?.length) {
    state.items = persisted.librarySnapshot.items;
    state.sections = persisted.librarySnapshot.sections || [];
    updateMovieYearFilters();
    updateMetacriticFilters();
    updateGenreFilters();
    els.librarySummary.textContent = `${activeLibraryItems().length.toLocaleString()} cached titles from ${state.sections.length} movie/show libraries.`;
  }

  applySavedFilters();
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

els.omdbApiKeyButton.addEventListener("click", () => {
  saveOmdbKey().catch((error) => setStatus(error.message));
});

els.signOutButton.addEventListener("click", () => {
  signOut().catch((error) => setStatus(error.message));
});
els.searchInput.addEventListener("input", saveFiltersAndRender);
els.typeFilter.addEventListener("change", saveFiltersAndRender);
els.movieYearStartFilter.addEventListener("change", saveFiltersAndRender);
els.movieYearEndFilter.addEventListener("change", saveFiltersAndRender);
els.metacriticStartFilter.addEventListener("change", saveFiltersAndRender);
els.metacriticEndFilter.addEventListener("change", saveFiltersAndRender);
els.genreFilter.addEventListener("click", (event) => {
  if (els.genreFilter.getAttribute("aria-disabled") !== "true") return;
  event.preventDefault();
});
document.addEventListener("click", (event) => {
  if (!els.genreFilter.open || els.genreFilter.contains(event.target)) return;
  els.genreFilter.open = false;
});
els.genreOptions.addEventListener("change", () => {
  updateGenreFilterSummary();
  saveFilters();
  renderItems();
});
els.genreClearButton.addEventListener("click", clearGenreFilters);
els.copyTitlesButton.addEventListener("click", () => copyTitles().catch((error) => setStatus(error.message)));
els.logCriticScoreButton.addEventListener("click", () => {
  fetchOmdbReviews().catch((error) => setStatus(error.message));
});

initialize().catch((error) => setStatus(error.message));
