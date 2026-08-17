# Canvas v3 convergence and release gate

Canvas v3 is the only product architecture in this repository. It uses one
hierarchical document, one shared command reducer, one daemon authority, and one
Canvas UI. There is no old parser, URL alias, read-only recovery reader,
dual-write store, shadow schema, second Canvas page, or CRDT.

## Durable current paths

```text
.gg/runtime/index.sqlite
.gg/runtime/canvas/<branch-hash>/
.gg/runtime/plugin-capabilities/<digest>.json
.gg/runtime/projection-plans/<branch-hash>.json
.gg/runtime/task-sessions.json
.gg/workspace/node-definitions.json
.gg/workspace/node-tree-definitions.json
artifacts/.branches/<branch-hash>/<runId>/files/
```

The one-time cutover reset recognizes retired targets only inside the guarded
reset routine. It holds the project lease, rejects symlinks/tracked files/path
escape, journals the operation, tombstones atomically, resumes after a crash,
and creates an empty v3 Canvas. It preserves the project catalog, Skills, and
user source. It creates no backup or archive.

## Current capabilities

- hierarchy, local matrices, lexical sibling order, typed data ports;
- immutable NodeExecution outputs, cache, history, provenance;
- editable asset assembly and trusted raster fallback;
- digest-pinned Docker/Podman Compute with explicit approval;
- opaque multi-root filesystem tree and digest-CAS sync conflicts;
- validated Agent GraphProposal and one-revision materialization;
- PDF.js trusted import, lazy pages, and tool-assisted decomposition;
- native editable PPTX objects, diagnostics, notes, and custom XML provenance;
- immutable NodeTreeDefinition instances, conflict preview, resolver, and
  atomic detach.

macOS is the only acceptance platform for this release. Host differences stay
behind daemon filesystem/container/font/PDF providers. Data-only NodeType
definitions contain no host branches.

## Enforced architecture gate

`npm run architecture:check` scans all 15 source roots and rejects retired
Canvas/Outcome modules, standalone snapshot Run types, versioned product
directories, old URL/directory literals, old Node fields, plugin component
escape hatches, direct SQLite access, and forbidden cross-layer imports.

Final visual artifacts are generated under `artifacts/ui-render/`. The
`v3-convergence` journey includes hierarchy, Compute approval, filesystem
conflict, GraphPlan review, PDF page strip, and PPTX export states. Each image
has executable selector/text checks recorded in `manifest.json`.

No intermediate main build after the destructive cutover is releasable. Only
the final convergence commit may be packaged for users after the complete gate
passes.
