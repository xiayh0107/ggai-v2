# Application architecture

This document defines the frontend dependency direction for the continuously evolving Canvas.
It is an implementation boundary, not a product design specification.

## Runtime composition

```text
pages (route composition)
  ├─ workspace / resources / node-studio (product domains)
  └─ components/canvas (Canvas presentation)
          ↓
      canvas (model, commands, selectors, persistence, Run application state)
          ↓
      agent + narrow daemon clients (transport)
```

- `pages/` may compose domains and create clients. Lower layers never import pages.
- `components/canvas/` renders Canvas state and delegates durable changes to `canvas/`.
- `canvas/` owns the model, reducers, selection semantics, outbox and Task Run lifecycle.
- `workspace/`, `resources/` and `node-studio/` own strict protocols for their product domains.
- Browser code never reads daemon-managed paths directly. Resource and project identity always
  comes from the corresponding daemon catalog.

## Node type boundary

```text
Node definition / built-in declaration / Agent candidate (strict data)
                    ↓ exact validation
              NodePlugin.ui template
                    ↓
          NodeTemplateView (content only)
                    ↓
     CanvasNodeCard (one platform-owned shell)
```

- `NodePlugin.ui` is an exact, serializable contract. A plugin selects one platform template; it
  cannot provide JSX, CSS, empty/running states, action chrome or layout.
- `CanvasNodeCard` is the only Node shell. It owns header, content-state arbitration, activity,
  selection, ports, actions and resize. Node Studio previews this component directly.
- `NodeTemplateView` owns only content typography for the finite template set. It cannot dispatch
  Canvas commands or render shell/state chrome.
- `NodeArtifactTemplateView` renders daemon-verified artifacts with the same finite template set.
  Plugins cannot provide an artifact component, projector, CSS hook or Canvas authority.
- `architecture:check` rejects restoring plugin `views`; future flexibility is added by extending
  and testing the data contract and platform renderers, not by giving plugins a component escape hatch.

## Agent automation boundary

```text
Agent RunOutcome (semantic output keys + task proposals)
                    ↓ daemon manifest / plugin claim validation
            daemon-owned ProjectionPlan
                    ↓ trusted Canvas command
       Node / Edge / Task IDs and layout assigned by Canvas
```

- Agents may name output types from the run-fixed plugin catalog and may propose bounded follow-up
  Tasks. They never author Canvas IDs, coordinates, payload patches, edges or commands.
- A target output slot fixes its Node type in Task context, so the Agent produces for a declared
  capability instead of guessing UI structure.
- Automatic output materialization and user-accepted Task proposals both pass through the same
  reducer, revision CAS and receipts. “More autonomous” must mean policy over trusted proposals,
  never direct mutation of the Canvas snapshot.

## One Canvas, rolling evolution

There is one product Canvas and one active implementation: `components/canvas/` for presentation
and `canvas/` for application state. Product directories, components and types must not encode
release generations such as `v1` or `v2`.

Durable wire formats may retain `schemaVersion` values and published endpoint paths while data is
still in circulation. Those values are compatibility facts at the protocol boundary, not product
layers and must never select a second renderer, store, route or user experience.

`npm run architecture:check` rejects versioned Canvas product paths and imports, archived browser
stores, composition-layer back imports and the aggregate legacy daemon client. New schema revisions
must be handled by parsers/migrations beside the single domain model rather than by copying the
entire application tree.

## Component ownership

- `CanvasStage.tsx` coordinates state and gestures. Pure selection/layout calculations belong in
  `CanvasStage.logic.ts`; plugin menu presentation belongs in `CanvasCreateNodeMenu.tsx`;
  confirmation, delayed commit and undo state belong in `CanvasActionHistory.tsx`.
- `CanvasContextComposer.tsx` coordinates Task creation. Resource catalog loading and selection
  belong in `CanvasAttachmentPicker.tsx`; immutable attachment identity helpers live in
  `canvas/attachments.ts`.
- `pages/ResourceLibrary.tsx` is only a route composition root. Workspace-level navigation lives in
  `resources/ResourceCenterHome.tsx`; the manifest-backed provider lives in
  `resources/GeneratedResourcesView.tsx`.
- `pages/Workspace.tsx` owns project lifecycle orchestration. Project presentation belongs in
  `workspace/WorkspaceProjectViews.tsx`; modal interaction belongs in
  `workspace/WorkspaceProjectDialogs.tsx`; sorting and route identity live in
  `workspace/projectViewModel.ts`.
- Side drawers, viewers, Task Run panels and Node cards remain independent surfaces. They communicate
  through typed contexts or application state, never by querying another component's DOM.

## Next cleanup sequence

1. Extract the remaining Stage gesture controllers behind tested hooks; destructive-action
   orchestration is already isolated.
2. Keep Workspace and Resource Center route roots limited to lifecycle and route composition; their
   dialogs, cards and providers are already isolated.
3. Keep Task Run calls on the narrow Canvas Run client and projection-plan wire types; do not add
   Canvas imports from the aggregate legacy client surface.
4. Split daemon routes by catalog, Canvas, Run and versioning domains while preserving one server
   composition root.
5. Treat compatibility formats as adapters with explicit removal criteria, never as parallel
   product implementations.

Every extraction must preserve behavior and pass focused tests, type checking, lint, architecture
checks and the relevant full suite. Large rewrites that mix migration with product changes are not
accepted.

`architecture:check` also applies conservative line budgets to composition roots already split in
this migration. These are regression tripwires, not style targets: when a root reaches its budget,
move a responsibility to its owning module instead of raising the limit.
