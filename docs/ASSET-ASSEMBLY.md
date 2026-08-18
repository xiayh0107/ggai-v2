# Editable asset assembly

`asset-assembly` is a Canvas hierarchy root. Its immediate children are
`asset-part` nodes, which each hold exactly one verified artifact reference, or
declarative `shape` nodes. Geometry stays in the Canvas `transform` and
`bounds`; source crop, pivot, opacity, blend, clip, and alternative text stay in
the data-only child payload.

The browser previews the same hierarchy used by the daemon. Executing the root
invokes the daemon-owned Sharp provider and writes immutable `assembly.png` and
`assembly.svg` artifacts. The editable node tree is never replaced or
overwritten by the render.

The renderer accepts only closed-manifest PNG, JPEG, WebP, and GIF inputs. It
does not dereference paths or URLs. Sharp keeps its untrusted-input protections
enabled, uses explicit pixel/channel bounds, and emits PNG with fixed encoding
options. This declarative rasterizer is also the fallback boundary for later
presentation export.
