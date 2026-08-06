# Canvas V2 UI foundation

This document describes the isolated Canvas V2 frontend data path and its first
interactive task-centric stage. V2 does not reuse or mutate the V1 React store.

## Entry gate

`/canvas` selects a model before either store mounts:

1. `VITE_GGAI_CANVAS_MODEL_V2` must explicitly be `1` or `true`.
2. When enabled, `GET /health` must report `capabilities.canvasModelV2: true`.
3. A disabled frontend flag mounts V1 without a health request.
4. An enabled frontend with an unsupported or unreachable daemon mounts neither
   model and shows an incompatibility error. It never silently falls back to V1,
   because doing so could mix V1 and V2 writes after an operator explicitly
   selected V2.

The gate lives above `useCanvasStore`, so the V1 hook cannot hydrate or persist
while V2 capability detection is pending.

## State ownership

| State | Owner | Persistence | Examples |
| --- | --- | --- | --- |
| Authoritative canvas | daemon V2 envelope | daemon branch document | tasks, nodes, collections, typed edges, receipts |
| Optimistic document | V2 store + command outbox | IndexedDB until acknowledged | local reducer projection of queued commands |
| Branch view | V2 store | IndexedDB, scoped by daemon URL + project + branch | camera, selection, collapsed tasks/collections, composer drafts |
| Task runtime | V2 store | none | run phase, progress, message, ghost outputs |
| Derived view | selectors | none | task status, presentation density, ghost layout, bounds, accessibility |

No camera, selection, collapse, draft, run, or ghost field is copied into
`CanvasDocumentV2`.

## Command path

`CanvasV2Store.dispatchCommand` applies these invariants:

1. Validate the command against the current optimistic document.
2. Under one outbox lock, calculate `baseRevision` as the locally acknowledged
   revision plus the current FIFO outbox length.
3. Persist the command before publishing its optimistic reducer result.
4. Resolve dispatch once it is durable and visible locally; do not wait for the
   network.
5. Drain through one active flush. Commands added during a flush remain ordered,
   are picked up by that drain (or a guaranteed follow-up drain), and cannot be
   lost in the flush-finalization race.
6. Keep conflicted commands durable and keep the optimistic projection visible.
   The daemon client retains its bounded behavior of one refetch, one whole FIFO
   rebase/replay, and no unbounded automatic conflict loop.

Outbox list/ack/rebase/enqueue operations share a small lock. This makes state
publication atomic with durability and prevents a flush result from overwriting
a command enqueued in the same event-loop window.

## React boundary

`CanvasV2Provider` owns loading and cleanup. `useCanvasV2State` subscribes with
`useSyncExternalStore`; the class store returns the same snapshot object until a
state transition, satisfying React's cached snapshot requirement. Task hooks
derive task views from the subscribed snapshot without persisting derived data.

The V2 shell mounts a real, task-centric stage. Its persistent visible
vocabulary is limited to Task, Node, Edge, and user-saved Collection, with
transient Ghost projections during execution:

- a task with no output is a task card;
- a task with one output is a title strip plus its node;
- a task with two or more outputs owns one frame around its child nodes;
- a collapsed task is one summary card, while its internal nodes and internal
  edges remain part of the authoritative document;
- a collection is an explicit top-level Task/Node grouping. It has no prompt or
  runtime, and can collapse into one boundary without changing member geometry;
- a running task may project non-persistent ghost output slots using the same
  layout function as trusted materialization.

Node bodies use the plugin registry for their identity and a conservative
generic renderer for text, code, structured payloads, and visual artifacts.
Artifact URLs are always run-owned (`runId` + `artifactId`); the UI does not
reconstruct paths from agent log text.

## Direct manipulation

Camera movement, zoom, selection, collapse state, and drag previews remain
branch-local view state. A gesture previews movement locally and emits exactly
one durable command on pointer release:

- dragging a Task emits one `MoveEntities` command for the Task; reducer
  semantics move the Task and every node whose `homeTaskId` points to it;
- dragging a Node emits one `MoveEntities` command for that Node;
- dragging a Collection emits one `MoveEntities` command on pointer release;
  reducer semantics move its direct Task/Node members and Task child nodes;
- resizing a Node emits one `ResizeNode` command;
- panning and cursor-anchored zoom only update branch view state;
- Shift-click toggles typed Task/Node/Collection selection, and Shift-drag on
  empty canvas adds intersecting visible entities through marquee selection.

Task and Node are separate selection types even when a Node belongs to a Task.
This preserves a minimal kernel: the Task is the run/prompt boundary and the
Node is an editable result, without introducing an additional bundle entity.

“Save as collection” persists only selected top-level Tasks and Nodes. Collection
ports are UI macros: they expand to member endpoints and submit one bounded
`CreateEdges` command containing ordinary typed edges. `relation` and
`contextRole` remain separate controls. When a Task or Collection is collapsed,
external edges aggregate at its boundary; hover or expansion fans them back out.

Destructive menu actions use an accessible confirmation dialog and a five-second
branch-local pending-deletion projection. The projection applies the same pure
reducer as a durable command, so entities and incident edges disappear
immediately. Undo clears the projection without writing a command; timeout writes
the destructive command, and a local dispatch rejection restores the document
and announces the failure. Active Tasks must be cancelled and acknowledged by
the daemon before either Task deletion action can be queued.

## Accessibility and motion

Every interactive entity has a native button as its focus target. One entity is
in the tab sequence at a time; arrow keys, Home, and End move the roving focus,
while Enter and Space select the focused entity. Pointer selection explicitly
focuses the same control, so rerenders and optimistic command acknowledgement do
not strand keyboard users. Collapse controls expose `aria-expanded` and
`aria-controls`, task containers expose group labels, and runtime changes are
coalesced through a throttled live region. Spinners, shimmer descendants, and
transitions provide reduced-motion variants.

## Verification

Focused tests cover:

- explicit frontend flag and branch parsing;
- frontend/daemon capability agreement, unsupported daemon, and failed probe;
- daemon health capability parsing;
- daemon + IndexedDB hydration and optimistic outbox replay;
- consecutive dispatch while a flush is blocked, FIFO base revisions, and the
  follow-up drain race;
- branch-only view persistence with no document command;
- transient runtime status and deterministic ghost projection;
- conflict retention;
- React provider hydration and runtime-driven hook updates.
- task-card, title-strip, multi-output frame, collapsed summary, and ghost
  rendering;
- run-owned artifact URLs and plugin-aware node content;
- typed Shift selection, additive marquee selection, roving focus, and focus
  retention across runtime updates;
- one-command pointer release for Task move, Node move, and Node resize;
- explicit collection save/assignment/removal, duplicate, dissolve, collapse,
  one-command group drag, and inverse-command undo;
- typed port connections, Collection macro expansion, collapsed edge bundles,
  hover fan-out, relation/context labels, and keyboard edge deletion;
- destructive confirmation, immediate pending-deletion projection, undo without
  dispatch, timeout dispatch, rejection restore, and active-Task deletion guard;
- rect-aware panning and cursor-anchored zoom.

## Deferred UI work

- run/SSE adapter that feeds `setTaskRuntime` and ghost updates;
- proposal review and materialization controls;
- specialized editors and viewers beyond the generic plugin-aware node body;
- V2 branch/version management UI;
- command conflict resolution UI beyond the exposed store state.
