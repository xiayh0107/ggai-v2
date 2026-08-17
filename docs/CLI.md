# GGAI Headless CLI

`ggai` is a thin interaction shell over the local daemon. It does not import
`RunManager`, daemon route implementations, `CanvasStore`, IndexedDB persistence,
or trusted artifact writers. Project, Canvas, Run, permission, and artifact facts
remain daemon-owned.

## Foundation commands

```bash
npm run build:cli
node dist-cli/ggai.js doctor
node dist-cli/ggai.js project list
node dist-cli/ggai.js project create demo
node dist-cli/ggai.js run "Create a scatter plot" --project demo --wait
node dist-cli/ggai.js continue task-id "Refine the title" --project demo --wait
node dist-cli/ggai.js log run-id --project demo
node dist-cli/ggai.js artifact list run-id --project demo
node dist-cli/ggai.js canvas show --project demo
node dist-cli/ggai.js canvas graph --project demo --format mermaid
node dist-cli/ggai.js node show node-id --project demo
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

`ggai run` creates a zero-output Task through the revisioned Canvas command API,
runs advisory preflight, registers an empty headless community capability set
(the daemon still contributes protected builtins), and starts the canonical
RunIntent. `--wait` consumes the durable SSE close and prints verified manifest
entries. Permission requests are denied by default; `--permission allow` is an
explicit opt-in suitable only for a trusted interactive invocation. Durable log
and artifact commands read daemon APIs rather than `.gg/` or artifact paths.

## Canvas and Node inspection

The CLI projects Canvas into semantic views instead of reproducing an infinite
surface:

- `canvas show` renders Tasks, output Nodes, top-level Nodes, and Collections.
- `canvas graph` renders typed relations as ASCII, Mermaid, DOT, or JSON.
- `node show` renders content and verified artifact metadata; layout is hidden
  unless `--debug-layout` is explicitly requested.

`ggai log` now emits a bounded, path-safe event summary by default. `--tools`
adds tool lifecycle rows without dumping tool payloads. `--raw` explicitly
returns the complete decoded permanent log for diagnostics.

## Installation and daemon bootstrap

```bash
cd app
npm link
ggai doctor
```

`ggai` is the primary command. A compatibility `gg` bin is published, but many
Zsh and Oh My Zsh Git plugins define `gg='git gui citool'`; aliases take
precedence over executable files. Use `ggai`, or explicitly remove that alias
from the current shell with `unalias gg` before using the compatibility name.

For the default loopback daemon URL, `ggai` probes `/health` and starts the
packaged daemon when it is absent. Automatic startup never applies to remote or
path-prefixed URLs. Use `--no-start-daemon` or
`GGAI_AUTO_START_DAEMON=0` to require an already-running daemon. Override the
current working directory used as the managed root with `GGAI_PROJECT_ROOT`
when needed.
