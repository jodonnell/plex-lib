# Plex Library Browser

A static web app that signs in to Plex, discovers your Plex Media Server resources, and lists all movie and TV show library items. Tokens, server discovery, and the latest loaded library snapshot are saved in this browser's IndexedDB.

## Run

```sh
npm start
```

Open the printed Vite URL.

For local development with hot reload:

```sh
npm run dev
```

To build static files:

```sh
npm run build
```

## Dump library metadata

```sh
PLEX_API_TOKEN=your-token PLEX_DUMP_OUTPUT=plex-metadata.json npm run dump:metadata
```

The dump writes JSON to stdout and progress to stderr. It discovers the first available Plex server, reads all movie and TV show sections, and includes the raw full title metadata returned by Plex for each item.
If you prefer shell redirection, use `npm --silent run dump:metadata > plex-metadata.json` so npm's run-script banner does not get captured before the JSON.
For a smaller dump with only basic normalized item fields, use:

```sh
PLEX_API_TOKEN=your-token PLEX_DUMP_OUTPUT=plex-metadata-short.json npm run dump:metadata:short
```

Optional filters:

```sh
PLEX_API_TOKEN=your-token PLEX_SERVER_NAME="My Server" npm run dump:metadata
PLEX_API_TOKEN=your-token PLEX_SERVER_URI="http://127.0.0.1:32400" npm run dump:metadata
PLEX_API_TOKEN=your-token PLEX_SECTION_ID=1 npm run dump:metadata
PLEX_API_TOKEN=your-token PLEX_DUMP_OUTPUT=plex-metadata.json npm run dump:metadata
PLEX_API_TOKEN=your-token PLEX_DUMP_FULL=0 npm run dump:metadata
PLEX_API_TOKEN=your-token PLEX_DUMP_SHORT=1 npm run dump:metadata
```

## Notes

- Requires Node 20.19 or newer.
- Sign in with Plex using the PIN flow or paste an existing `X-Plex-Token`.
- Pasted/PIN tokens and library data stay in browser IndexedDB.
- The app reads Plex libraries only. It does not modify your server.
