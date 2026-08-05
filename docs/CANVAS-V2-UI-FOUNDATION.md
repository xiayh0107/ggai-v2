# Canvas V2 UI foundation

This increment establishes a separate Canvas V2 frontend data path. It does not
reuse or mutate the V1 React store and intentionally stops before implementing
the full rich-task visual design.

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

The current V2 shell is deliberately diagnostic: loading/error handling, model
identity, entity counts, and an empty workspace foundation. It does not yet draw
rich task containers or enable editing.

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

## Deferred UI work

- rich task container, title-strip, output-frame, and collection rendering;
- zoom presentation transitions and direct manipulation;
- run/SSE adapter that feeds `setTaskRuntime` and ghost updates;
- proposal review and materialization controls;
- V2 branch/version management UI;
- command conflict resolution UI beyond the exposed store state.
