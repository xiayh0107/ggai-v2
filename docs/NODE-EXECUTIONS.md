# Node executions and provenance

`NodeExecution` is an operational Activity, not Canvas content and not a Task Run. The Canvas Node
stores only an optional `selectedExecutionId`; execution history and named outputs live in
`.gg/runtime/index.sqlite` through `MetadataStore`.

## Lifecycle

- `POST /nodes/:id/executions` accepts only `{ force }`; node identity, type, code/payload and inputs
  are resolved from the requested persistent Canvas branch.
- The daemon resolves a trusted executor provider by Node type. Missing providers return
  `node_executor_unavailable`; there is no browser eval or fallback process.
- Inbound `data` edges resolve exact upstream execution/output identities. The accepted execution
  records the resulting `inputsDigest`, type ref, environment digest, code digest and cache key.
- A matching successful cache entry is reused unless `force=true`. Terminal records and outputs are
  immutable; a forced run creates another execution id.
- Each execution is bounded to 1,024 output items. Inline JSON is limited to 256 KiB per item; larger
  content must use a verified ArtifactRef.

## API

- `POST/GET /nodes/:id/executions?projectDir=&branch=` starts or lists executions.
- `GET /executions/:id/outputs` reads named outputs.
- `GET /nodes/:id/provenance?projectDir=` reads bounded Entity–Activity–Agent relations.

The selected-node tray shows execution history and output counts. Selecting an execution uses the
ordinary `SelectNodeExecution` Canvas command; clearing it returns to latest-successful behavior.

Task Run acceptance also appends provenance links without moving prompt/session/log state into Node.
