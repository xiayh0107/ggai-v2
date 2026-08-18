# Immutable NodeTree definitions and instances

A `NodeTreeDefinition` is an immutable catalog revision with a content digest,
stable template-local node/edge keys, pinned NodeType refs, an override
allowlist, and exposed ports. Capturing a new revision never mutates an older
one. Nested definition references are traversed before append; direct and
indirect cycles are rejected.

A Canvas instance persists only:

- its ordinary root geometry and scope;
- `{ definitionId, revision, digest }`;
- `payload: { overrides }`, whose keys must appear in the pinned revision's
  allowlist.

It does not copy the base tree into Canvas storage. The daemon's single
`InstanceService` resolver is used by the resolved preview endpoint,
NodeExecution input, and PPTX export. Resolved children receive deterministic
IDs while the resolved root retains the instance ID, so root references stay
stable.

Updates are explicit. `update-preview` compares a target revision against
current overrides and exposed ports. Removed allowlist entries or ports are
reported as conflicts and block update. A conflict-free accepted update changes
only the pinned instance ref through the Canvas reducer.

`DetachInstance` is an opaque browser command. The daemon resolves the pinned
tree, rewrites exposed external port endpoints, and supplies a trusted expansion
to one reducer revision. The instance root becomes the concrete definition
root, children and internal edges are inserted atomically, no `instanceRef`
remains, and replay does not repeat the detach.
