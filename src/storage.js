import { createStore, delMany, getMany, set, setMany } from "idb-keyval";

const store = createStore("plex-lib", "app-state");

const keys = {
  clientId: "clientId",
  token: "token",
  servers: "servers",
  selectedServerId: "selectedServerId",
  librarySnapshot: "librarySnapshot",
};

export async function loadAppState() {
  const [clientId, token, servers, selectedServerId, librarySnapshot] = await getMany(
    [keys.clientId, keys.token, keys.servers, keys.selectedServerId, keys.librarySnapshot],
    store,
  );

  return {
    clientId: clientId || "",
    token: token || "",
    servers: Array.isArray(servers) ? servers : [],
    selectedServerId: selectedServerId || "",
    librarySnapshot: librarySnapshot || null,
  };
}

export function saveClientId(clientId) {
  return set(keys.clientId, clientId, store);
}

export function saveToken(token) {
  return set(keys.token, token, store);
}

export function saveServers(servers) {
  return set(keys.servers, servers, store);
}

export function saveSelectedServerId(serverId) {
  return set(keys.selectedServerId, serverId, store);
}

export function saveLibrarySnapshot(snapshot) {
  return set(keys.librarySnapshot, snapshot, store);
}

export function saveLibraryState({ servers, selectedServerId, librarySnapshot }) {
  return setMany(
    [
      [keys.servers, servers],
      [keys.selectedServerId, selectedServerId],
      [keys.librarySnapshot, librarySnapshot],
    ],
    store,
  );
}

export function clearPlexState() {
  return delMany([keys.token, keys.servers, keys.selectedServerId, keys.librarySnapshot], store);
}
