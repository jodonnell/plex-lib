# Plex Library Browser

A local web app that signs in to Plex, discovers your Plex Media Server resources, and lists all movie and TV show library items.

## Run

```sh
npm start
```

Open http://localhost:4173.

To connect automatically with an existing Plex token:

```sh
PLEX_API_TOKEN=your-token npm start
```

## Dump library metadata

```sh
PLEX_API_TOKEN=your-token npm run dump:metadata > plex-metadata.json
```

The dump writes JSON to stdout and progress to stderr. It discovers the first available Plex server, reads all movie and TV show sections, and includes the raw full title metadata returned by Plex for each item.

Optional filters:

```sh
PLEX_API_TOKEN=your-token PLEX_SERVER_NAME="My Server" npm run dump:metadata
PLEX_API_TOKEN=your-token PLEX_SERVER_URI="http://127.0.0.1:32400" npm run dump:metadata
PLEX_API_TOKEN=your-token PLEX_SECTION_ID=1 npm run dump:metadata
PLEX_API_TOKEN=your-token PLEX_DUMP_OUTPUT=plex-metadata.json npm run dump:metadata
PLEX_API_TOKEN=your-token PLEX_DUMP_FULL=0 npm run dump:metadata
```

## Notes

- Requires Node 18 or newer.
- Sign in with Plex using the PIN flow, paste an existing `X-Plex-Token`, or set `PLEX_API_TOKEN`.
- Pasted/PIN tokens stay in browser `sessionStorage` and are sent only to the local Node server. `PLEX_API_TOKEN` stays on the server.
- The app reads Plex libraries only. It does not modify your server.
