# Validated Agent graph proposals

`RunOutcome.graphProposal` is an optional, bounded draft. It contains at most
256 logical nodes and 512 port-to-port edges. A node may provide only a logical
key, type ID, title, optional parent key, and schema-limited init object. An
edge may provide only source/target logical keys and named ports.

The parser rejects Canvas IDs, coordinates, transforms, order keys, absolute
paths, commands, container images, environment fields, secrets, and auto-run
requests. The daemon then pins full immutable NodeType snapshots and validates:

- constructibility and exact daemon-owned JSON Schema;
- authorized opaque resource root handles;
- containment types, cycles, and depth up to 32;
- port existence, direction, identical schema URI, cardinality, and data DAG;
- the 256-node / 512-edge hard limits.

Only after validation does the daemon create a digest-bound
GraphMaterializationPlan. It assigns all Canvas IDs, local/world transforms,
sibling order, root Task ownership, and edge ordering deterministically. The
browser receives the whole graph for one accept/reject decision.

Acceptance sends only `{ type: "MaterializeGraphPlan", planId }`. The daemon
resolves the stored plan, applies all nodes and edges through one Canvas reducer
revision, and writes a `graph-materialization` receipt plus provenance. Replay
returns the receipt without duplicating entities. Acceptance never starts a
NodeExecution.
