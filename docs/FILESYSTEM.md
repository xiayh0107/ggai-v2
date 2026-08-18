# Workspace filesystem bindings

The daemon owns a multi-root workspace catalog. A registered root stores its
canonical host path only in metadata. Browser and Agent responses expose an
opaque `rootId`, display name, and relative paths; they never expose the host
path.

`GET /filesystem/tree` returns at most 100 entries with an opaque cursor. Tree
browsing never creates Canvas nodes. A user pins only the Project, Directory,
or File entries they choose.

File bindings use one of three modes:

- `fs-authoritative`: disk changes update Canvas; Canvas cannot save back.
- `canvas-authoritative`: Canvas may save with base-digest CAS; concurrent disk
  edits create a conflict.
- `bidirectional`: only UTF-8 text, Markdown, JSON, CSV, and code are allowed.
  Either clean side may advance the shared base; A→B and A→C creates an
  explicit conflict.

Chokidar events are hints that enqueue descriptor-bound digest reconciliation.
The watcher never establishes truth from timestamps. Writes use a same-folder
temporary file, `fsync`, a second base-digest check, atomic rename, directory
`fsync`, and a digest echo token. Symlink components and path traversal are
rejected. Inode identity follows ordinary and case-only renames; deletes become
an explicit `missing` binding state.

Creating a binding commits `BindNodeToFilesystem` through the shared Canvas
command reducer. Filesystem-originated text changes similarly commit
`UpdateNodeContent`, preserving Canvas revision history.
