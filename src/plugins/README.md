# GGAI 节点插件规范

画布上的一切节点——包括所有内置类型——都以完全相同的插件形态存在。
内置插件（`builtins/`）与社区 / 用户插件能力对等，没有任何特权。

插件如何参与 Task、typed Edge 与 Agent 上下文由核心统一定义，规范见
[`../../docs/PLUGIN-CONTEXT-CONTRACT.md`](../../docs/PLUGIN-CONTEXT-CONTRACT.md)。社区插件不得
自行实现来源传播、文件授权或 Task input 组装。

## 一个节点的基本要素

| 要素 | 字段 | 说明 |
| --- | --- | --- |
| 身份 | `id` / `label` / `desc` / `icon` | 全局唯一 id；社区插件建议带命名空间 `@author/video` |
| 几何 | `defaultWidth` | 创建时的缺省宽度（高度由内容自适应，引擎实测回填） |
| 内容契约 | `initialPayload()` + `isEmpty(node)` | 节点的本体数据结构与"空内容"判定；空 → 空白态，非空 → 内容态 |
| UI 契约 | `ui.schemaVersion` / `ui.template` | 必填、纯数据；只允许平台白名单内容模板，不允许 JSX / CSS / Node shell |
| 指令配置 | `instr.placeholder` / `instr.actions` / `instr.actionsFor` | 输入占位、专属快捷指令，以及按节点内容与来源动态计算的快捷指令（可选） |
| Artifact 声明 | `artifactClaims` | 必填、纯数据：声明插件接受的扩展名 / MIME 类型与优先级 |
| Agent 上下文 | `nodeContext` | 必填、纯数据：分别约束 summary/full 的正文、payload 字段与 artifact identity |
| 创建入口 | `creatable` | 缺省为 `true`；设为 `false` 时仅可承接产物投影，不进入创建菜单或首屏面板 |

## 引擎为所有插件统一提供

- 节点外壳：头部（图标 + 标题 + 右上角操作条）、选中态、连接端口、缩放手柄
- 画布引擎：无限平移缩放、拖拽、连线 / 关系标签、框选组框
- 指令生命周期：`idle → generating → done`，摘要条、骨架屏、取消
- 状态递进约定：**节点创建时必须为空**，内容只在「提交 → 生成动画 → 完成」之后出现
- 指令面板骨架：附件 / 来源小窗、输入区、发送按钮（插件只填占位、快捷指令与参数槽）
- 结果结算：通用 artifact 对账、Agent 后续动作建议和刷新恢复由引擎统一处理；插件只声明有限内容模板

## 扩展一个新类型

```tsx
import { FileVideo } from 'lucide-react'
import { registerPlugin } from '@/plugins/types'
import { defineNodeUi } from '@/plugins/uiContracts'

registerPlugin({
  id: 'video',
  label: '视频',
  desc: '上传视频、提取关键帧与字幕',
  icon: FileVideo,
  defaultWidth: 320,
  initialPayload: () => ({}),
  isEmpty: (n) => !n.text?.trim() && Object.keys(n.payload).length === 0,
  ui: defineNodeUi('media'),
  instr: {
    placeholder: '提取关键帧、转录字幕、总结内容…',
    actions: ['提取关键帧', '转录字幕', '总结内容'],
  },
  artifactClaims: [{
    extensions: ['.mp4', '.mov'],
    mediaTypes: ['video/*'],
    priority: 20,
  }],
  nodeContext: {
    schemaVersion: 1,
    summary: { textMaxChars: 300, payloadFields: ['duration'] },
    full: { textMaxChars: 8_000, payloadFields: ['duration'], artifactRefs: 'all' },
  },
})
```

注册后，可创建插件会出现在创建菜单与首屏面板。每次 Run 启动前，浏览器把当前启用的
community data-only claims 与 Node context policy 注册给 daemon；daemon 返回固定 registry
digest，并把该快照绑定到整个 Run。后续插件热更新只影响新 Run，不会改变正在执行或恢复中的
artifact 分类与上下文裁剪。所有插件
仍可参与来源小窗、连线和指令面板。只用于展示未知产物的 fallback 插件应设置
`creatable: false`；community 插件不能声明 `acceptsUnknown`。

## Artifact contract 边界

`artifactClaims` 的数据契约位于 `artifactContracts.ts`。浏览器 `registerPlugin()` 和 daemon
使用同一个校验器：插件 id 不得重复；每个插件最多 32 条规则；单条规则的扩展名与 MIME
matcher 各最多 64 个；`priority` 必须是 `-1000..1000` 的安全整数。扩展名必须带点并使用
小写（例如 `.r`）；匹配 artifact 路径时会先把实际扩展名规范化为小写，因此 `analysis.R`
仍由 `code` 插件接收。重复 id 会被拒绝；需要热替换的模块应在 HMR dispose 阶段先调用
`unregisterPlugin(id)`，内置插件已处理这个生命周期。

内置 `code` / `image` / `pdf` / `table` / `text` / `file` 只在这个 data-only registry 中
维护一次。typed claim 按 `priority` 排序，同优先级再比较匹配具体度与稳定 id；`file` 是未知
格式的最低优先级兜底，不需要成为创建菜单中的独立 UI 插件。daemon 只导入这个 `.ts` 数据
模块，绝不导入 `types.tsx`、`builtins/`、React、Lucide 或任何 renderer。

浏览器通过 `PUT /plugin-capabilities` 注册 claims；daemon 合并不可覆盖的内置 registry、受信
runtime contributions 与 browser-community claims，规范化为带来源的 v3 并按 digest 保存到
`.gg/runtime/plugin-capabilities-v3/<digest>.json`。Run acceptance 会在 reservation 内重新读取
runtime contributions；变化会要求调用方重试，接受后的 Run 只读自身快照。历史 v2 不进入新 Run，
仅用于 crash recovery。浏览器只在 daemon 用 manifest 校验 `{ runId, artifactId }` 后，才把产物交给平台模板。
普通 Node 内容始终由 `NodeTemplateView` 按 `ui.template` 渲染；插件、社区包与 Agent 候选都
不能注入 JSX、CSS 或状态组件。daemon 验证的
`{ runId, artifactId, mediaType, size, contentDigest, title, url }` 由
`NodeArtifactTemplateView` 按同一有限模板渲染；`url` 仅供当前浏览器读取，不写入 Canvas。
插件拿不到 entity id、坐标、edges、commands 或 dispatcher，因此不能创建节点、决定布局或
修改图关系。新增展示能力必须扩展数据契约与平台 renderer，并补齐平台测试。

## Node context contract 边界

`nodeContext` 只能收窄 Node 内容，不能重解释 `contextRole`。`summary` 永远不授予 artifact；
`full.artifactRefs='all'` 也只传递 identity，daemon 仍必须从 closed manifest 复验后才提供只读路径。
`payloadFields` 是顶层字段白名单，适合排除仅服务于显示、选择或交互的 payload；若确实需要兼容
旧插件，可使用 `full.payloadFields='all'`。每次编译结果在 `pack.json` 中保存
`contextProjection` receipt，明确正文字符数、payload 字段数以及 artifact 的策略/预算省略数。

## 约定

- **生成优先（generation-first）**：这是 Agent 生成画布，不是资产柜。空态主行动是"描述需求，Agent 生成"；导入已有资产（拖文件、贴链接）只作为次要路径出现在辅助文案里
- 颜色只用设计令牌（`gg.*`），不引入渐变、不显示模型名与积分
- 视图组件保持"内容优先"：插件只渲染主体区，外壳与状态条不归插件管
- `payload` 结构由插件自定，持久化时随节点保存；避免引用引擎内部字段
- `artifactClaims` 必须是 JSON 可序列化数据；不要放函数、renderer、正则表达式或运行时对象
- `nodeContext` 必须通过共享严格校验器；不要用它传路径、提示词模板或可执行 projector
- `instr.actions` / `actionsFor` 是无结构化 Agent 结果时的 UI 兜底；成功 run 返回的上下文建议会优先展示
- 节点来源以 `Edge` 为唯一事实源；`instruction.sources` 仅保留为旧数据兼容镜像，插件不应读写它
- 插件 ID 不参与连接或上下文分支；相同手势、Edge 与 contextRole 对所有内置和社区插件必须产生相同 Task inputs
- 当前输出槽资格不能由浏览器函数 `isEmpty` 单独证明；需要支持空节点直接运行的插件应让 `initialPayload()` 返回 `{}`，参数默认值先保留在 UI，等待用户确认后再持久化
