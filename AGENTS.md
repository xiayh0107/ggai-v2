# AGENTS.md — GGAI 生成式图形工具

> 给后续 agent / 贡献者的项目手册。读完这份文件，你应该能安全地修改这个项目，
> 并且会写一个新的节点插件。

## 项目是什么

生成式图形工具（React 19 + TypeScript + Vite + Tailwind + shadcn/ui；本地 Node daemon）。
无限画布 + 节点 + 连线，每个节点有内容（text / table / formula / chart …），
节点上方/下方挂一个"通用指令区"（prompt 面板）。设计规范见仓库根的 `DESIGN.md`。

## 设计红线（改了会被打回）

- 主色 `gg.primary` `#1769E0`，白底 / 浅灰辅助；**禁止渐变**。
- 不出现任何模型名称、算力单位、点数 / credits 之类的字眼。
- 内容优先：内容区是主角，UI 环绕它，不喧宾夺主。
- 圆角体系：节点卡片 `rounded-[16px]`，成组框 `rounded-[18px]`，面板 `rounded-2xl`。

## 代码地图

```
src/
  types/canvas.ts          # CanvasNode / Edge / CreateMenuState … 纯类型
  agent/                   # Agent 接入层（见 docs/AGENT-ARCHITECTURE.md）
    types.ts               # 统一事件 / 上下文包 / 会话
    context.ts             # 上下文打包器（三层裁剪，画布→Agent）
    runtime.ts             # 执行生命周期 + 传输层契约
    daemonClient.ts        # HTTP/SSE AgentTransport（浏览器→本地 daemon）
  plugins/
    types.tsx              # NodePlugin 契约 + 注册表（含未知类型回退）
    shared.tsx             # makeEmptyView / MetaLines 共享视图
    builtins/index.tsx     # 9 个内置插件（也是"普通插件"，无任何特权）
    README.md              # 插件规范（人读版，最详细）
  hooks/useCanvasStore.ts  # zustand store：节点/连线/选择/生成态
  persistence/             # IndexedDB journal / 相机状态，daemon 断线缓冲
  components/canvas/
    CanvasStage.tsx        # 画布：拖拽/连线/框选/成组/待创建虚线
    NodeCard.tsx           # 节点外壳（头部/端口/缩放），内容委托给插件
    EdgeLayer.tsx          # 连线路径 + hover 胶囊（标签/从连线新建/删除）
    InstructionPanel.tsx   # 通用指令区（按插件配置渲染）
    CreateMenu.tsx         # 新建节点菜单（列出启用中的插件）
    PluginManager.tsx      # 插件管理界面（左侧栏"资源"入口）
    EmptyState.tsx         # 空画布引导
```

```
daemon/
  index.ts                 # 127.0.0.1 服务入口
  server.ts                # HTTP/CORS/SSE 路由
  runs.ts                  # run 生命周期、事件缓存与取消
  canvasStore.ts           # revision CAS + 原子画布快照（当前事实源）
  runLogs.ts               # 永久 JSONL 运行日志与摘要
  canvasGit.ts             # 独立画布 Git 历史与受管 worktree
  sourceGit.ts             # 可选源码 Git 绑定、worktree 与 checkpoint
  workspaceVersioning.ts   # 快照、画布 Git、源码 Git 的一致性协调
  packer.ts / watcher.ts   # 上下文落盘与 artifact 对账
  sessions.ts              # 原子会话持久化与损坏隔离
  permissions.ts           # projectRoot、路径与命令安全策略
  translator.ts            # ACP/Codex/plain 输出归一化
  transport/               # acpx 与原生 Codex 子进程适配
```

关键数据流：`makeNode(type)` → `getPlugin(type)` 取 `initialPayload()` 存进
`node.payload`；渲染时 `NodeBody` 用 `plugin.isEmpty(node)` 决定显示 `views.Empty`
还是 `views.Content`；点“执行”后经 `DaemonClient` 启动本地 run，SSE 的 `file-write`
事件写回 `node.payload.artifactFiles`。引擎只管“节点有没有内容、是不是在生成”，
**不懂任何具体类型**。`demoResult` 只保留为插件原型契约，不再是默认执行路径。

## 多选与成组

`selectedIds: string[]`；Shift+拖拽框选、Shift+点击加选。多选时 CanvasStage 在
成员节点**下层**画一个"大号节点"（白色卡片 + 四个加号端口 + 图标工具栏），
从成组端口拖出 = 同时引用所有成员；新建成功后成组框自动消失，留下 N 条连线。
连线中点 hover 胶囊的"+"可从一条连线新建节点（同时引用两端节点）。

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
  isEmpty: (n) => !n.payload?.videoUrl,          // 决定 Empty / Content 视图

  views: {
    Empty: makeEmptyView(Clapperboard, '导入视频', '支持 MP4 / MOV'),
    Content: ({ node }) => <div className="p-4">{/* 渲染 payload */}</div>,
  },

  instr: {                        // 通用指令区配置（可选）
    placeholder: '对这个视频做什么？',
    actions: ['总结要点', '提取字幕'],
  },

  demoResult: (n, prompt) => ({ ...n, payload: { ...n.payload, videoUrl: '…' } }),
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
3. 不要引入新的节点级状态字段；`instruction.phase === 'generating'` 由引擎统一处理。
4. 样式只用 `gg.*` 设计 token；遵守上面的设计红线。
5. `isEmpty` 必须准确 —— 它决定空态/内容态切换，也影响"已生成"汇总条。
6. 未知类型有回退（文件上标个问号），所以你禁用/卸载插件不会弄坏旧画布。

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

改动画布交互后，用 Playwright（或手动）至少过一遍：新建节点 → 拖出连线新建 →
框选成组新建 → 禁用某插件后新建菜单里它消失、画布上旧节点变回退态。

依赖通过 npm 命令增删，并同时更新 `package.json` 与 `package-lock.json`；开发和 CI 安装均允许正常执行依赖生命周期脚本。详细分类、升级流程和外部 CLI 边界见 `docs/DEPENDENCIES.md`。

## 常用修改入口速查

| 想改什么 | 去哪里 |
| --- | --- |
| 新增 / 修改节点类型 | `src/plugins/builtins/index.tsx` |
| 节点外壳（端口、头部、汇总条） | `src/components/canvas/NodeCard.tsx` |
| 连线路径 / hover 行为 | `src/components/canvas/EdgeLayer.tsx` |
| 指令区通用行为 | `src/components/canvas/InstructionPanel.tsx` |
| 插件管理界面 | `src/components/canvas/PluginManager.tsx` |
| Agent 上下文 / 执行 | `src/agent/`（先读 `docs/AGENT-ARCHITECTURE.md`，后端见 `docs/AGENT-BACKEND.md`） |
| 全局状态 | `src/hooks/useCanvasStore.ts` |
| 画布持久化 / Git 分支 | `docs/CANVAS-PERSISTENCE.md`、`daemon/workspaceVersioning.ts` |
