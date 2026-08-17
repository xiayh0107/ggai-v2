# GGAI Headless CLI

`gg` is a thin interaction shell over the local daemon. It does not import
`RunManager`, daemon route implementations, `CanvasStore`, IndexedDB persistence,
or trusted artifact writers. Project, Canvas, Run, permission, and artifact facts
remain daemon-owned.

## Foundation commands

```bash
npm run build:cli
node dist-cli/gg.js doctor
node dist-cli/gg.js project list
node dist-cli/gg.js project create demo
node dist-cli/gg.js run "Create a scatter plot" --project demo --wait
```

Use `--daemon-url` or `GGAI_DAEMON_URL` to select a daemon. The default is
`http://127.0.0.1:7380`.

`--json` emits one stable JSON envelope:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "command": "project.list",
  "result": {
    "projects": []
  }
}
```

Human-readable results and JSON success envelopes use stdout. Diagnostics and
JSON error envelopes use stderr.

## Exit codes

| Code | Meaning |
| ---: | --- |
| 0 | Success |
| 1 | Unexpected internal failure |
| 2 | Invalid CLI usage |
| 3 | Daemon unavailable |
| 4 | Daemon request or protocol failure |

## Product boundary

The CLI resolves projects only through the daemon Workspace catalog. It never
treats an arbitrary directory as a Project, never reads `.gg/` or `artifacts/`
directly, and never bypasses Canvas revision/command or Run acceptance checks.

The first release gate is a browser-free vertical slice:

```text
Create Task → preflight → Run → events/permission → durable close → artifacts
```

Canvas remains a visual shell over the same durable facts rather than the owner
of the workflow.

`gg run` creates a zero-output Task through the revisioned Canvas command API,
runs advisory preflight, registers an empty headless community capability set
(the daemon still contributes protected builtins), and starts the canonical
RunIntent. `--wait` consumes the durable SSE close and prints verified manifest
entries. Until an explicit interactive policy lands, permission requests are
denied by default.
