# Container compute

`compute` nodes choose one daemon-owned runtime preset: `python-3.13` or
`node-24`. A node cannot provide an image, command, host path, network policy,
environment variable, or output declaration. Presets use immutable OCI image
digests.

On macOS the runtime provider probes Docker first and Podman second. A CLI whose
engine is not reachable is unavailable. The daemon never falls back to running
code as a host process.

Every run uses a read-only root filesystem, a non-root user, `network=none`, all
capabilities dropped, `no-new-privileges`, and CPU, memory, PID, wall-time,
temporary-filesystem, and output-size limits. Verified upstream artifacts are
copied into a private input staging directory and mounted read-only. `/outputs`
is a size-bounded tmpfs copied out only after a successful exit.

Code must write `/outputs/execution-result.json` with this exact shape:

```json
{
  "schemaVersion": 1,
  "outputs": {
    "result": [{ "path": "result.txt" }]
  }
}
```

Every regular output file must appear exactly once. Symlinks, hardlinks,
traversal, undeclared files, malformed sidecars, and more than 1024 items fail
the execution. Approval is persisted only for the exact node, code-tree digest,
and image/environment digest; changing any of them requires a new approval.
