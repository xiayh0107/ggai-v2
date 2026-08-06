# Canvas V2 状态重置

Canvas V2 不读取或迁移 V1 画布。切换项目前，必须显式运行一次可恢复 reset，把旧状态整体归档并创建全新的 V2 事实源。

## 安全边界

- 命令默认只预览；只有 `--apply` 才会改变磁盘。
- project root 必须是真实路径、当前源码 Git worktree 根，且不能是文件系统根目录或用户主目录。
- `.gg/runtime`、`.gg/canvas-state`、`.gg/canvas-worktrees` 和 `artifacts` 内只要存在源码 Git tracked 文件，就拒绝执行。
- 目标及父目录不能是 symlink；不会跟随 symlink 搬运数据。
- live daemon 会阻止 reset。stale daemon lease 只会在显式 `--apply` 中随旧 runtime 一起归档，不会被静默删除。
- reset 与 daemon 共享 `.gg/canvas-maintenance.lock` 栅栏；任一方获得写权时，另一方不能启动。
- 旧状态只使用同文件系统 `rename` 移动到 `.gg/legacy-v1/<timestamp>/`，不会物理删除。
- 每次移动后都会更新 `.gg/canvas-v2-reset.pending.json`。进程中断后，再次显式 `--apply` 会继续同一事务，不会另建归档或重复移动。

## 使用

先停止 daemon，再预览：

```bash
npm run canvas:v2:reset -- --project-root "$PWD"
```

确认预览中的项目与归档路径后执行：

```bash
npm run canvas:v2:reset -- --project-root "$PWD" --apply
```

机器可读预览可增加 `--json`。

完成后会生成：

```text
.gg/
├── canvas-model.json
├── legacy-v1/<timestamp>/
│   ├── .gg/runtime/
│   ├── .gg/canvas-state/
│   ├── .gg/canvas-worktrees/
│   ├── artifacts/
│   └── reset-journal.json
└── runtime/canvas-v2/<main-branch-hash>/snapshot.json
artifacts/.branches/
```

`.git`、tracked source files、`.gg/source-worktrees` 和其他用户源码 worktree 不在 reset 目标内。

## 故障处理

- `daemon_instance_active`：先正常停止 daemon，不能用 reset 强杀进程。
- `canvas_maintenance_stale`：上一次维护进程可能异常退出；先核对 lock 中 PID 与操作日志，再由操作者处理。daemon 和脚本都不会自动抢占。
- `canvas_v2_reset_interrupted` 或 pending journal：保持现状，重新运行相同的 `--apply` 命令继续。
- `tracked_reset_target` / `unsafe_managed_path`：修正 Git 跟踪或路径结构后重新预览，禁止用 force 绕过。

归档恢复是人工运维动作：先停止 daemon，再把当前 V2 状态另行保存，然后根据 `reset-journal.json` 逆向移动。应用本身不会自动回退到 V1，也不会混合读取两种 schema。
