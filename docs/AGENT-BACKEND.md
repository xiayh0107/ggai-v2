# Agent Daemon 后端设计与实现（GGAI 画布）

> 前置阅读：`docs/AGENT-ARCHITECTURE.md`（总分层与上下文工程）。
> 本文档同时记录当前实现与后续协议期边界。
> 核心原则：**daemon 很薄——不实现 Agent loop，只做五件事**：
> 打包落盘 → 启动/恢复 Agent 进程 → 翻译事件 → 监听产物 → 会话记账。

## 当前状态（2026-08）

骨架期已经落地并接入画布默认执行路径：

- 独立 Node 服务：原生 `http` + SSE，只绑定 `127.0.0.1:7380`
- 两条 transport：`acpx --format json` 与本机可直接验证的 `codex exec --json`
- `packContext` 落盘、NodePlugin 文件契约导出、chokidar artifact 对账
- 节点/Agent 会话原子持久化、resume、acpx 协议级取消，以及 POSIX 进程组 / Windows 进程树兜底清理
- 精确 Origin/JSON 边界校验、projectRoot 防 traversal/symlink、事件缓存与晚订阅重放
- 浏览器 `DaemonClient` 与画布 `generating → done/cancel/error` 生命周期接线

运行与验证：

```bash
npm run dev            # Vite + daemon；daemon 源码变更自动重启
npm run dev:frontend   # 仅前端，供拆分进程调试
npm run test:daemon
npm run build
```

## 一、进程形态

两种部署形态，同一套代码：

| 形态 | 场景 | 说明 |
|------|------|------|
| Electron main | 桌面 App | daemon 作为 Electron 主进程模块，渲染进程即画布 UI，IPC 通信 |
| 独立本地服务 | 浏览器版 | `ggai-daemon` 后台进程，UI 通过 HTTP + SSE 通信（默认 `127.0.0.1:7380`，只绑回环地址） |

技术选型：Node 22.22+ 或 Node 24 LTS / TypeScript。不引入重型框架——原生 `http` + 子进程管理 + 文件监听（`chokidar`）即可。

## 二、职责清单（做与不做）

**做**：
1. **上下文落盘**：接收画布快照后调用 `packContext`，写 run-scoped `.gg/context/runs/<runId>/`；另维护 `.gg/context/pack.md` 作为“最近一次”调试视图。项目已有的根 `AGENTS.md` 永不覆盖
2. **进程管理**：启动 Agent 子进程、设置工作目录与沙箱参数；acpx prompt 先通过 named session 发 cooperative cancel，短时等待后才清理本地客户端，并在客户端不可能再入队后对常驻 queue owner 二次 cancel；ensure 阶段直接清理。相同 cwd、adapter、sessionName 强制单飞，避免会话级 cancel 误伤另一 run；关闭服务时先停止接单再取消全部 run
3. **事件翻译**：ACP `session/update` / Codex JSONL / plain stdout → `CanvasAgentEvent`，经 SSE（或 IPC）推给 UI
4. **产物与结果对账**：`chokidar` 只监听当前 run 的不可变产物目录，文件写入 → `file-write` 事件（带 nodeId）→ UI 更新节点 payload 与 `phase: done`；成功结束时从私有 `.ggai/` 控制目录安全读取可选的有界 `RunOutcome`，该目录不进入 watcher、artifact snapshot 或预览接口
5. **会话记账**：`sessions.json` 持久化 `节点 ↔ Agent sessionId` 映射，供 resume

**不做**：
- 不实现模型调用、工具循环、上下文窗口管理（那是 Agent CLI 的事）
- 不存用户凭证；只跑 `<cli> login status` 类探针
- 不直接改画布状态（状态唯一事实源是前端 store；daemon 只发事件，UI 决定如何对账）
- 不监听外网端口、不做多用户（单机单用户，权限边界即本机用户）

## 三、模块结构

```
daemon/
├── index.ts            # 入口：HTTP/SSE 或 Electron IPC 装配
├── server.ts           # HTTP/CORS/JSON/SSE 边界
├── protocol.ts         # wire DTO 与运行时校验
├── runs.ts             # run 生命周期、事件缓存、取消与最终状态
├── registry.ts         # Agent 探测：PATH spawn + login status 探针
├── transport/
│   ├── acpx.ts         # spawn acpx --format json（快速落地备选）
│   ├── codex.ts        # codex exec --json / resume
│   ├── process.ts      # stdio、AbortSignal、SIGTERM/SIGKILL 兜底
│   └── types.ts        # 后端 transport 契约
├── translator.ts       # 各协议事件 → CanvasAgentEvent
├── packer.ts           # 复用 src/agent/context.ts：落盘 .gg/context/ 与 .gg/skills/
├── watcher.ts          # artifacts/ 文件监听 → file-write 事件
├── outcome.ts          # 可选 RunOutcome sidecar 的安全、有界读取与校验
├── sessions.ts         # 会话映射持久化（sessions.json）
└── permissions.ts      # 权限策略：路径白名单 / 命令分级 / 网络开关
```

`transport/` 下每个文件实现同一个接口——就是前端 `src/agent/runtime.ts` 里已定义的 `AgentTransport`，前后端共享这一份契约。新增 Agent 的常规工作量 = 在 ACP Registry 里已有则零代码，全新协议才加一个 transport。

## 四、API 面（独立服务形态）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/agents` | 探测到的 Agent 列表（available / authStatus / models），并行探测、故障隔离 |
| GET | `/health` | 健康状态与 daemon projectRoot |
| POST | `/runs` | 发起执行。body: `{ runId?, nodeId, agentId, prompt, projectDir, canvasSnapshot }`；客户端可预分配 `runId` 以消除取消窗口，同 id 重试幂等 |
| GET | `/runs/:id/events` | SSE 事件流（`CanvasAgentEvent` 序列） |
| GET | `/runs/:id` | 查询 run 状态 |
| POST | `/runs/:id/cancel` | 取消并等待 run 进入终态后响应，保证同节点可立即安全重跑 |
| GET | `/artifacts?projectDir=&path=` | 在项目边界内读取 `artifacts/` 产物；拒绝 traversal / symlink escape，文本预览上限 1 MiB、其他文件 100 MiB |
| POST | `/permissions/:id` | UI 回传权限裁决（allow/deny） |
| GET | `/sessions?nodeId=` | 查会话（调试用） |

Electron 形态下同样的操作映射为 IPC channel，前端调用层封装成同一个 `DaemonClient` 接口，两种形态可互换。

## 五、一次执行的完整时序

```
UI(指令面板执行)
  │ POST /runs { nodeId, agentId, prompt, canvasSnapshot }
  ▼
daemon.packer     → packContext() → 写 .gg/context/runs/<runId>/ + run-scoped skills
daemon.sessions   → 查 sessionId（有则 resume）
daemon.transport  → spawn: acpx named-session ensure + prompt / codex exec --json
  │
  ├─ Agent stdout ─→ translator ─→ SSE ─→ UI：节点 generating，进度文字
  ├─ Agent 写 branch/run 隔离的 artifactDir/x.png ─→ watcher ─→ file-write ─→ UI 记录路径
  ├─ Agent 请求权限 ─→ permission-request（ACP SDK transport 上线后可交互回传）
  └─ 结束 ─→ translator: done ─→ sessions.ts 记账 ─→ 成功时读取可选 RunOutcome
                                              └─ close 携完整 artifact snapshot + outcome?
                                              └─ UI 以 close 为终点，对账后经 GET /artifacts 渲染正文/图片
```

`RunOutcome` 不建立第二套消息系统。Agent 只写一个严格 JSON sidecar；daemon 根据当前
run 的 `artifactDir` 读取，因此身份由 daemon 的 `close.runId` 与 `RunSummary.nodeId`
绑定，不接受 Agent 自报的 run/node 字段。sidecar 缺失、损坏、超限、未知版本或经
symlink 重定向时一律视为“无 outcome”，不改变主任务的成功状态。错误和取消的
`close` 永不携带 outcome。`close` 仍写入永久 JSONL，因此同一字段天然支持刷新重放；
旧版不含 outcome 的 close 继续有效。

## 六、权限与安全

daemon 启动的是一个能写文件、跑命令、联网的本机进程，必须分级：

1. **项目边界**：所有 `projectDir` 必须 canonical resolve 在启动参数 `--project-root` 内；拒绝 traversal、symlink escape 与恶意节点路径
2. **Codex 写白名单**：源码未绑定时主 cwd 是 `.gg/runs/<runId>` 且项目源码只读；仅用 `--add-dir` 授权当前不可变 artifactDir。显式绑定后 cwd 切到对应的受管 source worktree。
3. **路径/命令策略**：`permissions.ts` 已实现 artifact/`.gg` 判定，以及允许/确认/危险命令三级分类；写入项目依赖的 install/add/ci 命令在快速开发阶段直接允许，`npx`/`bunx`/`dlx` 一次性下载执行仍需确认，破坏性系统操作仍拒绝，并为 ACP SDK 的 permission bridge 提供纯策略层
4. **acpx 一期边界**：acpx 默认禁用，必须以 `--acpx-agent` / `GGAI_ACPX_AGENTS` 显式 opt-in。启用后使用 `--cwd <projectDir>`、`--json-strict` 与 `--non-interactive-permissions fail`；每次执行先 `sessions ensure --name <stableName>`，再向该命名会话发送 prompt，同一会话禁止并发。取消走 `cancel -s <stableName>`，确认本地客户端关闭后再 cancel 一次常驻 owner。默认 `approve-reads`，只有操作者显式传 `--acpx-approval approve-all` 才放开非交互写入。细粒度 UI permission round-trip 尚未接 ACP SDK；`POST /permissions/:id` 会明确返回 `501 permission_bridge_unavailable`，不会假装已转发
5. **HTTP 边界**：只绑回环地址；daemon 默认只接受端口 3000 的 localhost/127.0.0.1 Origin，一体开发启动器会根据 Vite 的 `--host` / `--port` 精确追加本次 Origin，手动拆分时额外来源仍必须显式 `--allow-origin`；限制 Content-Type、请求体大小、图规模、并发 run 数与单 run 订阅数；SSE 支持 `Last-Event-ID` 有界重放；产物读取只允许 canonical path 位于当前项目 `artifacts/` 下，并设置 `nosniff`、CSP 与大小上限
6. **凭证**：只运行 CLI 自身的登录状态探针，daemon 不读取、不复制、不持久化 key/OAuth 数据

## 七、持久化文件

```
project/
├── .gg/
│   ├── runtime/canvas/<branch-hash>/snapshot.json # 当前画布事实源（revision CAS）
│   ├── runtime/runs/<runId>/events.jsonl           # 永久运行事件
│   ├── runtime/runs/<runId>/events.idx             # 固定宽度分页索引
│   ├── runtime/runs/<runId>/summary.json           # 可恢复的运行摘要
│   ├── runtime/canvas-daemon.lock                  # 项目单写者 lease
│   ├── runtime/preferences.json                    # 项目级自动化偏好
│   ├── canvas-state/       # 独立画布 Git 历史（不依赖源码 Git）
│   ├── canvas-worktrees/   # daemon 锁定的画布分支 worktree
│   ├── source-worktrees/   # 显式绑定后创建的源码分支 worktree
│   ├── context/pack.md      # 最近一次上下文包（每次执行覆盖，历史进版本）
│   ├── context/pack.json    # 同一上下文的机器可读形态
│   ├── context/AGENTS.md    # 最近一次调试视图（契约仍指向具体 run）
│   ├── context/runs/<runId>/# 每个并发 run 的隔离上下文与 skills
│   ├── skills/              # 从 NodePlugin 注册表导出的类型契约 Markdown
│   ├── runs/<runId>/        # Codex 沙箱的最小主工作目录
│   └── sessions.json        # { "branch:nodeId:agentId": { sessionId, createdAt, lastActiveAt } }
└── artifacts/.branches/<branch-hash>/<runId>/<nodeId>/  # 新运行的不可变产物
    └── .ggai/run-result.json # Agent 写、daemon 校验的私有控制 sidecar；不作为 artifact 暴露
```

完整保存顺序、刷新重连、分支与恢复语义见 `docs/CANVAS-PERSISTENCE.md`。`.gg/` 是 daemon 管理的持久状态，不是可随构建目录一起删除的缓存。

## 八、落地顺序（三期）

1. **骨架期（已完成）**：acpx/Codex transport + SSE + watcher + DaemonClient，真实节点执行闭环。
2. **协议期（下一步）**：加 ACP SDK transport，接 ACP Registry 做 Agent 发现/安装；把现有权限策略接到交互式 permission response。
3. **体验期**：当前已有并发上限、分支运行租约、永久执行日志和画布版本摘要；后续加入可视队列、大历史时间索引/可达性 GC，以及资源面板里的"计算集群/服务器"远程 daemon。

## 九、风险与取舍

- **ACP/acpx 均在 pre-1.0**：接口可能变。用 `transport/` 目录隔离，变化只波及一个文件；acpx 只做备选，协议底座押 ACP SDK。
- **acpx 跨进程队列边界**：公开 CLI 的 cancel 针对 session 当前 turn，不能按 request id 删除其他进程已提交的 pending 请求。进程内单飞、client-close 后二次 cancel 已封闭正常竞态；非正常 daemon 崩溃或外部共用 GGAI session 仍需人工清理遗留 owner，因此 acpx 不作为默认生产 transport。
- **外部 CLI 能力门禁**：Codex/acpx 不作为项目 npm 依赖。入口支持 `--codex-command` / `--acpx-command`（及对应环境变量），registry 记录解析后的绝对路径并检查 transport 所需 flags、所选 approval 模式、配置的 adapter、named-session ensure、prompt 与 session cancel 参数；不兼容版本不会进入 run。
- **plain-text Agent**：只能出文本的 CLI 降级为"约定 `<artifact>` 标签 + 结束后扫描落盘"，体验分级展示，不假装支持完整能力（对应调研第八节）。
- **Electron 暂缓**：先把独立服务形态做稳，桌面化时 daemon 代码整体平移进 main 进程。
