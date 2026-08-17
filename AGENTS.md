# AGENTS.md — GGAI 生成式图形工具

> 给后续 agent / 贡献者的项目手册。读完这份文件，你应该能安全地修改这个项目，
> 并且会写一个新的节点插件。

## 项目是什么

生成式图形工具（React 19 + TypeScript + Vite + Tailwind + shadcn/ui；本地 Node daemon）。
Canvas 以 Task 为提示与运行边界，Node 只承载内容，typed Edge 分离语义关系与 Agent
上下文，Collection 只保存顶层布局集合。**节点 / 画布设计规范见仓库根的 `DESIGN.md`
（唯一权威基准，改 canvas 外壳、工具条、面板、连接交互前必读）**，架构规范见
`docs/CANVAS.md`，历史退化复盘见 `docs/CANVAS-REGRESSIONS.md`。

## 设计红线（改了会被打回）

- 主色 `gg.primary` `#1769E0`，白底 / 浅灰辅助；**禁止渐变**。
- 不出现任何模型名称、算力单位、点数 / credits 之类的字眼。
- 内容优先：内容区是主角，UI 环绕它，不喧宾夺主。
- 圆角体系：节点卡片 `rounded-[16px]`，成组框 `rounded-[18px]`，面板 `rounded-2xl`。

## 代码地图

```
src/
  canvas/             # model / command reducer / outbox / Run / selectors
  components/canvas/  # Task-centric stage、容器、Edge、proposal、版本 UI
  workspace/          # Project catalog 浏览器客户端与严格协议解码
  agent/              # Task Run 浏览器适配层（见 docs/AGENT-ARCHITECTURE.md）
    types.ts          # 统一事件与运行状态
    taskContext.ts    # 当前 Task 上下文数据结构
    taskRunHttpClient.ts # 严格 HTTP/SSE 协议客户端
    taskRunClient.ts  # Canvas store 所需的窄适配器
  plugins/
    types.tsx              # NodePlugin 契约 + 注册表（含未知类型回退）
    builtins/index.tsx     # 9 个内置插件（也是"普通插件"，无任何特权）
    README.md              # 插件规范（人读版，最详细）
  skills/
    contracts.ts           # SkillAssetRef、类型/实例绑定与继承规则
    client.ts              # Workspace skill 管理严格 HTTP 客户端
```

```text
cli/                 # `ggai` headless shell; daemon HTTP only, no CanvasStore or direct .gg access
```

```
daemon/
  index.ts                 # 127.0.0.1 服务入口
  server.ts                # HTTP/CORS/SSE 路由
  canvasCommandStore.ts    # command CAS、exactly-once 与 semantic revision
  workspaceVersioning.ts   # checkpoint、branch、conflict、merge
  runArtifactStorage.ts    # Run-owned artifact manifest 与安全读取
  projectionPlan.ts        # outcome × manifest × plugin claims
  runs.ts                  # run 生命周期、事件缓存与取消
  runLogs.ts               # 永久 JSONL 运行日志与摘要
  canvasGit.ts             # 独立 Canvas Git 历史与受管 worktree
  taskSessions.ts          # branch + Task + Agent 会话
  projectCatalog.ts        # Workspace Project 身份、受管目录与最近打开
  pluginCapabilities.ts    # Run-fixed artifact claim + Node context snapshot
  skillAssets.ts           # Workspace skill 不可变快照、类型绑定与安全解析
  packer.ts / watcher.ts   # 上下文落盘与 artifact 对账
  permissions.ts           # projectRoot、路径与命令安全策略
  translator.ts            # ACP/Codex/plain 输出归一化
  transport/               # acpx 与原生 Codex 子进程适配
```

关键数据流：浏览器把 command 写入 IndexedDB outbox 并乐观运行共享 reducer → daemon
按 revision CAS 与 mutation receipt exactly-once 提交 → `RunIntent(taskId, revision)` 从持久
Canvas 编译上下文 → `file-write` 只显示 ghost → durable close 生成 ArtifactManifest 与可信
ProjectionPlan → daemon 原子创建 Node/Edge/receipt。Node 只保存 `{runId, artifactId}`，不保存
prompt、phase、session、日志或磁盘路径。插件通过 data-only `artifactClaims`、纯
`projectArtifact` 与 `views.Artifact` 渲染 verified artifact；核心不按 plugin id 分支。
Node task skill 的类型默认、实例继承/替换与 Run 固定规则见 `docs/NODE-SKILLS.md`；禁止从
UI 或 Run 扫描默认 skill 路径，外部目录只能作为显式导入源。

Workspace 的 Project 边界见 `docs/WORKSPACE-PROJECTS.md`。Project 不等于 Canvas branch、
Task 或 Collection；首页只读取 daemon catalog，禁止用静态数组、localStorage 或目录扫描
伪造项目。浏览器路由只保存 opaque project id，Canvas store 必须在 daemon 成功 open 后
才能用受控 `projectDir` 挂载。

## 多选与成组

Shift+拖拽框选、Shift+点击只产生 branch-local 临时多选，不进入 Canvas 文档。用户必须
点击“保存为集合”才创建 Collection；Collection 不保存 `memberIds`，成员关系只在顶层
Task/Node 的 `collectionId` 上。Collection 端口是 UI macro：一次 bounded command 创建成员
的普通 typed Edge，Collection 本身不是 Edge 端点。Task 可以直接成为 Edge 端点。

## 如何构建一个节点插件（必读）

完整规范在 `src/plugins/README.md`，这里是速查：

一个插件 = 一个满足 `NodePlugin` 接口的对象（见 `src/plugins/types.tsx`）：

```tsx
export const videoPlugin: NodePlugin = {
  id: 'video',                    // 全局唯一，kebab-case
  label: '视频',                   // 菜单/卡片标题
  desc: '上传或引用视频片段',       // 一句话描述（插件管理界面显示）
  icon: Clapperboard,             // lucide 图标
  defaultWidth: 340,              // 新建时的初始宽度

  initialPayload: () => ({ videoUrl: null }),   // 内容契约：存进 node.payload
  isEmpty: (n) => !n.payload?.videoUrl,         // 决定内容是否为空

  views: {
    Content: ({ node }) => <div className="p-4">{/* 渲染 payload */}</div>,
    Artifact: ({ artifact }) => <video controls src={artifact.url} />,
  },

  artifactClaims: [{ extensions: ['.mp4', '.mov'], mediaTypes: ['video/*'], priority: 20 }],
  nodeContext: {
    schemaVersion: 1,
    summary: { textMaxChars: 300, payloadFields: ['duration'] },
    full: { textMaxChars: 8_000, payloadFields: ['duration'], artifactRefs: 'all' },
  },
  projectArtifact: (artifact) => ({ title: artifact.title }),

  instr: {                        // 通用指令区配置（可选）
    placeholder: '对这个视频做什么？',
    actions: ['总结要点', '提取字幕'],
  },
};
```

注册（两种都行）：

```tsx
// 内置：src/plugins/builtins/index.tsx 的 PLUGINS 数组加一项
// 运行时（社区/自定义）：
registerPlugin(videoPlugin);
```

规则：
1. **生成优先**：画布的主线是 Agent 生成。空态主行动写"描述需求，Agent 生成"，导入已有资产只做辅助文案。
2. 内容一律走 `node.payload`，**不要**给 `CanvasNode` 加类型专属字段。
3. 不要给 `CanvasNode` 增加 prompt、phase、session 或日志字段；运行态只在 Task Run store。
4. `artifactClaims` 必须是 JSON 可序列化数据；community 插件不能覆盖内置声明或接管 unknown fallback。
5. `projectArtifact` 必须是纯函数；拿不到 entity ID、坐标、Edge、command 或 dispatcher。
6. 样式只用 `gg.*` 设计 token；遵守上面的设计红线。
7. `isEmpty` 仍应准确；artifact 投影的身份与安全元数据以 daemon manifest 为准。
8. 未知格式由不可创建的通用 `file` fallback 承接，禁用插件不会破坏已持久化 Node。

## 构建与验证

```bash
npm run dev          # 一条命令拉起 Vite + daemon；后端变更自动重启，Ctrl+C 同时退出
npm run dev:frontend # 仅启动 Vite（只用于拆分进程调试）
npm run dev:all      # npm run dev 的兼容别名
npm run build        # tsc -b && vite build，必须通过
npm run test:daemon  # daemon 单元 + HTTP/SSE 集成测试
npm run test:ui      # React StrictMode 画布状态/交互回归测试
npm test             # daemon + UI 全部测试
npm run deps:check   # manifest/lock 一致性 + 非阻断式依赖信息报告
npm run deps:audit   # 手动严格漏洞审计；CI 中仅报告、不阻断
npm run verify       # 完整 lint + 测试 + 构建 + 最小 daemon runtime
npm run daemon -- --project-root "$PWD"
npm run preview      # 本地预览
```

改动画布交互后，用浏览器至少过一遍：新建 Task → Run 生成多个 artifact Node → 折叠 /
展开 Task → 从产物派生新 Task → Shift 框选并保存 Collection → 创建 typed Edge → checkpoint /
恢复分支。确认裂解不 fit view、不转移 Task 焦点，刷新和重复 close 不重复物化。

高风险 UI 回归同时保存精简的修复前 / 修复后截图到
`docs/screenshots/ui-regressions/`，并在同目录 README 中关联行为测试。截图服务于人工审查，
不能替代组件状态、键盘交互和错误恢复的自动化断言。

依赖通过 npm 命令增删，并同时更新 `package.json` 与 `package-lock.json`；开发和 CI 安装均允许正常执行依赖生命周期脚本。详细分类、升级流程和外部 CLI 边界见 `docs/DEPENDENCIES.md`。

## 常用修改入口速查

| 想改什么 | 去哪里 |
| --- | --- |
| 新增 / 修改节点类型 | `src/plugins/builtins/index.tsx` |
| Task/Node 外壳与 Stage | `src/components/canvas/`（先读仓库根 `DESIGN.md` 设计基准 + `docs/CANVAS-REGRESSIONS.md` 防复发清单） |
| model / command / outbox / Run | `src/canvas/` |
| daemon persistence / artifact / plan | `daemon/canvasCommandStore.ts`、`daemon/runArtifactStorage.ts`、`daemon/projectionPlan.ts` |
| Agent 上下文 / 执行 | `src/agent/`（先读 `docs/AGENT-ARCHITECTURE.md`，后端见 `docs/AGENT-BACKEND.md`） |
| 画布持久化 / Git 分支 | `docs/CANVAS-PERSISTENCE.md`、`daemon/workspaceVersioning.ts` |

## 滚动演进规则

- 仓库只保留一套当前 Canvas 实现。功能演进直接更新当前 model、reducer、协议客户端和 UI，
  不创建 `v2` 目录、`V3` 类型、双启动开关或并行页面。
- 持久化和 HTTP 协议可以有 `schemaVersion`，但版本号属于数据兼容性，不属于产品层级；
  解码、迁移和归档代码必须集中在明确的兼容边界，不能渗入组件与业务命名。
- 破坏性模型变化采用“先扩展读取 → 写当前格式 → 后续移除旧读取”的滚动迁移，测试同时覆盖
  当前写入与旧数据读取。迁移完成后删除旧实现，不留永久 fallback。
- 每次改动保持 main 可构建、可测试、可启动；优先小而完整的纵向切片，禁止复制整套架构后再切流。
