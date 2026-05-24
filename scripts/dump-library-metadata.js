#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import {
  APP_NAME,
  DEFAULT_DETAIL_CONCURRENCY,
  DEFAULT_PAGE_SIZE,
  createClientId,
  createPlexHeaders,
  dumpLibraryMetadata,
} from "../src/plex.js";

const token = process.env.PLEX_API_TOKEN?.trim() || "";
const clientId = createClientId("plex-lib-dump");
const requestedServerUri = process.env.PLEX_SERVER_URI?.trim() || "";
const requestedServerName = process.env.PLEX_SERVER_NAME?.trim() || "";
const requestedSectionId = process.env.PLEX_SECTION_ID?.trim() || "";
const outputPath = process.env.PLEX_DUMP_OUTPUT?.trim() || "";
const pageSize = Number(process.env.PLEX_DUMP_PAGE_SIZE || DEFAULT_PAGE_SIZE);
const detailConcurrency = Number(process.env.PLEX_DUMP_DETAIL_CONCURRENCY || DEFAULT_DETAIL_CONCURRENCY);
const fetchFullMetadata = process.env.PLEX_DUMP_FULL !== "0";

if (!token) {
  console.error("Missing PLEX_API_TOKEN. Example: PLEX_API_TOKEN=your-token npm run dump:metadata");
  process.exit(1);
}

function plexHeaders(serverToken = token) {
  return createPlexHeaders({
    token: serverToken,
    clientId,
    platform: "CLI",
    device: "Local CLI",
    deviceName: `${APP_NAME} Metadata Dump`,
  });
}

async function main() {
  const dump = await dumpLibraryMetadata({
    token,
    headersForToken: plexHeaders,
    serverUri: requestedServerUri,
    serverName: requestedServerName,
    sectionId: requestedSectionId,
    pageSize,
    detailConcurrency,
    fetchFullMetadata,
    onSection: (section) => console.error(`Dumping ${section.title} (${section.type})...`),
  });

  const json = `${JSON.stringify(dump, null, 2)}\n`;
  if (outputPath) {
    await writeFile(outputPath, json);
    console.error(`Wrote metadata dump to ${outputPath}`);
    return;
  }

  process.stdout.write(json);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
