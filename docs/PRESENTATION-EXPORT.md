# Editable PowerPoint export

`presentation` contains ordered `slide` children. A slide owns a pt coordinate
space and may contain ordinary Canvas nodes. The daemon exporter maps `text`,
verified `image`, `shape`, `table`, and `chart` nodes to native editable
PptxGenJS objects. Slide payload notes become native speaker notes.

Three explicit modes are available:

- `hybrid` (default): known objects stay native; unsupported nodes use the
  trusted declarative rasterizer.
- `editable`: the same safe fallback is retained, but every unsupported node
  also produces an `unsupported-editable-node` diagnostic.
- `fidelity`: every slide child is rendered through the trusted rasterizer.

Images are loaded only from verified closed-manifest artifact descriptors and
embedded as data URIs. URL/path fields in node payloads are ignored; the
exporter never downloads external resources. Requested fonts are preserved in
native objects. If the macOS font catalog cannot find one, export diagnostics
name it explicitly instead of silently changing the font.

Every export produces immutable `presentation.pptx`,
`export-diagnostics.json`, and `provenance.json` artifacts. The canonical
provenance manifest fixes Canvas revision, mode, presentation identity, every
participating NodeType ref, and artifact refs. The same JSON is embedded in an
OOXML `customXml/item1.xml` part with a root relationship and content-type
override.

Before closing the artifact manifest, the daemon reopens the ZIP in memory and
verifies every internal OOXML relationship target. The regression suite also
checks that native text/table/chart objects, notes, raster fallback, font
diagnostics, custom XML, and provenance artifacts survive decompression.
