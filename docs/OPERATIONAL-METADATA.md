# Operational metadata authority

The daemon owns one local operational database at `.gg/runtime/index.sqlite`. Canvas semantic
history remains in the Canvas command/Git system; immutable artifact bytes remain outside SQLite.
The database holds execution indices, named outputs, filesystem roots and bindings, sync conflicts,
and queryable provenance.

## Runtime boundary

- Node.js 24.19+ is required. Startup fails when the linked SQLite is older than 3.51.3.
- `DatabaseSync` exists only in `metadataWorker.ts`. A dedicated WorkerThread owns the sole write
  connection so synchronous SQLite work never blocks the daemon HTTP/event loop.
- The connection uses WAL, foreign keys, a five-second busy timeout, full synchronous writes,
  defensive mode, and disabled extension loading.
- Business domains depend on `MetadataStore`; they do not receive SQL strings or a raw database.
- Schema changes run under `BEGIN IMMEDIATE` and advance `PRAGMA user_version` atomically.
- Initialization runs `PRAGMA quick_check`. An unsupported schema or failed integrity check blocks
  daemon startup instead of creating a replacement database.

## Path and lifecycle safety

The database and backups must resolve below the real daemon-owned `.gg/runtime` directory. Symlinked
roots, database files, and backup directories are rejected. Files are mode `0600`, directories are
mode `0700`, and application shutdown closes the metadata worker idempotently.

`MetadataStore.backup()` uses SQLite's online backup API and writes only daemon-generated names below
`.gg/runtime/backups`. Future domain migrations must take a verified backup before changing a
non-rebuildable operational schema.
