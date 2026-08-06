# Workspace Projects

The workspace home is a real project control plane. It must not infer projects
from Canvas branches, Tasks, browser storage, or arbitrary directories found on
disk.

## Entity boundary

- **Project** is a durable workspace identity with its own project directory,
  Canvas state, Run state, artifacts, and project lease.
- **Branch** is a version line inside one Project.
- **Task**, **Node**, and **Collection** are entities inside one Project's Canvas.
- The browser URL carries only an opaque Project id. A daemon catalog resolves
  that id to the controlled internal `projectDir` used by the existing Canvas
  and Run clients.

`project_root` is the stable catalog identity for the daemon's configured root.
It preserves the Canvas that existed before the project dashboard was wired up.
New projects use daemon-generated ids of the form `project_<32 lowercase hex>`.

## Durable layout

```text
<daemon-project-root>/.gg/workspace/
├── projects.json
└── projects/
    └── project_<id>/
        ├── .gg/
        │   └── canvas-model.json
        └── artifacts/
```

`projects.json` is the only discovery source. The daemon never scans `src/`,
`daemon/`, `node_modules/`, or other folders and guesses that they are projects.
The catalog is exact-schema, atomically replaced, protected by the root project
lease, and stored below daemon-owned `.gg/workspace` state. Agent writes to that
area are denied.

Each newly managed directory receives a blank-project Canvas V2 marker bound to
its opaque Project id. This is distinct from the reset marker used when a root
project archives V1 state; a new project never pretends to have performed a V1
migration.

## HTTP contract

```text
GET  /projects
POST /projects                 { "title": "…" }
POST /projects/:projectId/open
```

Responses use schema version 1 and exact Project records:

```ts
interface WorkspaceProject {
  id: string
  title: string
  projectDir: string
  createdAt: string
  updatedAt: string
  lastOpenedAt: string | null
  state: 'ready' | 'unavailable'
  summary: {
    taskCount: number
    nodeCount: number
    collectionCount: number
  } | null
}
```

Creation normalizes and validates the title, stages a new directory, writes and
verifies its identity marker, atomically moves it into the managed projects
root, then publishes the catalog record. A failed initialization is never
listed as a ready Project.

Opening performs catalog lookup, marker/identity verification, project lease
acquisition, and Canvas hydration before `lastOpenedAt` is persisted. A missing
or damaged registered directory remains visible as `unavailable`; it is not
silently removed or recreated.

Project summaries are read from the durable main-branch snapshot without
creating a Canvas store, acquiring every child Project lease, or mutating the
Canvas. Missing snapshots deterministically summarize as an empty Canvas.

## Browser flow

1. Workspace loads `GET /projects` and renders only returned records.
2. Creating a Project calls `POST /projects`, then navigates to
   `/canvas?project=<opaque-id>`.
3. Before mounting any project-scoped Canvas store, the Canvas entry calls the
   open endpoint and receives the controlled `projectDir`.
4. Malformed or duplicate `project` URL parameters fail closed; they never fall
   back to another Project.
5. `/canvas` without a project id remains a compatibility link for
   `project_root`.

The workspace refetches after the window regains focus, so returning from a
Canvas shows the daemon-owned recent-open timestamp and current durable summary.
Search filters the real records. UI areas without a backend (for example team
projects) show an explicit unavailable state instead of sample data.

## Non-negotiable invariants

- Never use `localStorage` as the Project source of truth.
- Never model Projects as Canvas branches.
- Never accept a browser-supplied absolute project path during creation.
- Never scan the daemon root to discover Projects.
- Never open a managed Project whose marker id differs from its catalog id.
- Never update `lastOpenedAt` before a Project has actually opened.
- Never delete or overwrite an unavailable Project as part of listing it.
- Never let an Agent modify `.gg/workspace` catalog or managed Project control
  state from the root Project.
