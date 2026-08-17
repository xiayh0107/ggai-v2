# Trusted PDF import and decomposition

`POST /imports/pdf` accepts only a closed-manifest `application/pdf` artifact.
The daemon reads its verified descriptor into a bounded `Uint8Array` and gives
PDF.js no URL, base URL, range transport, or remote resource location. Range,
stream, auto-fetch, worker fetch, XFA, system fonts, and form annotations in
previews are disabled. Documents with JavaScript actions are rejected.

Imports are limited to 64 MiB and 10,000 pages. Encrypted PDFs return a password
requirement; the API deliberately rejects password fields, so passwords are
never persisted in plans or metadata. Malformed and oversized documents fail
before a Canvas command is created.

The initial daemon plan contains exactly one `pdf-document` root with the
source artifact identity, digest, page count, and bounded metadata. Even a
300-page document creates no Page nodes. `GET /imports/:id/plan?page=N` loads
one verified page, returns its pt viewport, text/annotation summaries, and
generates one immutable PNG preview artifact. Every page calls `cleanup()` and
every loading task calls `destroy()` in `finally`.

Fine decomposition is a separate Agent/tool flow. The Agent may call an
authorized tool such as MinerU and submit a restricted GraphProposal to
`POST /imports/:id/decomposition`. The daemon checks:

- the exact source PDF digest and page range;
- Document → Page → TextBlock/Image/Annotation parent types;
- page-local pt bbox containment;
- image artifact existence, media type, and equality with the declared tool
  Run (cross-Run references are rejected).

The resulting digest-bound plan is accepted only through the opaque
`MaterializeDecompositionPlan` Canvas command. It adds every child in one
revision, writes a decomposition receipt/provenance, and never executes the
nodes automatically.
