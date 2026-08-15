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

The configured filesystem root is the Workspace control boundary, not a
Project. It has no catalog record, Canvas identity marker, browser route, Run
history, or artifact inventory. User projects exist only under the daemon-owned
catalog and use ids of the form `project_<32 lowercase hex>`.

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

Each newly managed directory receives a blank-project Canvas marker bound to
its opaque Project id. This is distinct from the reset marker used when a root
project archives incompatible state; a new project never pretends to have performed an archived
migration.

## HTTP contract

```text
GET  /projects
POST /projects                 { "title": "…" }
POST /projects/:projectId/open
DELETE /projects/:projectId
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

`GET /projects` returns managed user Projects only. The daemon's internal root
record is deliberately outside this public protocol.

A successful delete returns the exact removed identity:

```json
{ "schemaVersion": 1, "deletedProjectId": "project_<32 lowercase hex>" }
```

Creation normalizes and validates the title, stages a new directory, writes and
verifies its identity marker, atomically moves it into the managed projects
root, then publishes the catalog record. A failed initialization is never
listed as a ready Project.

Opening performs catalog lookup, marker/identity verification, project lease
acquisition, and Canvas hydration before `lastOpenedAt` is persisted. A missing
or damaged registered directory remains visible as `unavailable`; it is not
silently removed or recreated.

Permanent deletion is available only for managed, ready Projects. The daemon's
configured filesystem root can never be deleted. The daemon rejects deletion while a Run or
another destructive project operation is active, drains queued Canvas/version
writes, fences new project-scoped work, evicts cached stores, and releases the
child Project lease before touching the directory. It then revalidates the
catalog-derived path and identity marker, atomically renames the directory to a
daemon-owned tombstone, atomically removes the catalog record, and finally
cleans the tombstone. Interrupted tombstones are reconciled from catalog state:
a still-registered Project is restored, while a committed deletion is finished.

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
5. `/canvas` without a managed project id fails closed and returns the user to
   Project selection; it never opens the configured filesystem root.
6. Deleting a managed Project requires an explicit destructive confirmation.
   The browser removes it from both project views only after the daemon returns
   the exact deleted Project id; failures leave the Project visible and retryable.
7. The Workspace-level Resource Library entry navigates to `/resources` without
   selecting a Project. Project-scoped resource providers require an explicit
   user selection, unless the user entered from a Canvas that already establishes
   the current opaque Project id.
8. Resource providers reuse this Project catalog for scope. They never scan the
   daemon root or managed Project directories to discover Projects or resources.

The complete Resource Library IA, routes, provider boundaries, and naming rules
are defined in [`RESOURCE-LIBRARY.md`](./RESOURCE-LIBRARY.md).

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
- Never manufacture a Project identity for the configured Workspace root.
- Never delete the configured filesystem root, a symlinked/mismatched Project directory, or a
  Project with active/pending Runs.
- Never remove a catalog record before project-scoped writes are fenced and
  drained, and never let an old `projectDir` request recreate a deleted Project.
- Never let an Agent modify `.gg/workspace` catalog or managed Project control state.
- Never make “most recent”, first-ready, the Workspace root, or browser-local state
  the implicit Project for a Workspace-level resource navigation action.
- Never let a Resource Library provider build a second Project discovery path or
  recursively scan Project roots to infer resources.
