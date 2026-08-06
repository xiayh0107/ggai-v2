# GGAI 节点插件规范（v0.1）

画布上的一切节点——包括 9 种内置类型——都以完全相同的插件形态存在。
内置插件（`builtins/`）与社区 / 用户插件能力对等，没有任何特权。

## 一个节点的基本要素

| 要素 | 字段 | 说明 |
| --- | --- | --- |
| 身份 | `id` / `label` / `desc` / `icon` | 全局唯一 id；社区插件建议带命名空间 `@author/video` |
| 几何 | `defaultWidth` | 创建时的缺省宽度（高度由内容自适应，引擎实测回填） |
| 内容契约 | `initialPayload()` + `isEmpty(node)` | 节点的本体数据结构与"空内容"判定；空 → 空白态，非空 → 内容态 |
| 视图 | `views.Empty` / `views.Content` / `views.Artifact` | 常规空白态、内容态，以及可选的 V2 已验证产物视图；生成中骨架屏由引擎统一接管 |
| 指令配置 | `instr.placeholder` / `instr.actions` / `instr.actionsFor` / `instr.ParamSlot` | 输入占位、专属快捷指令、按节点内容与来源动态计算的上下文快捷指令（可选）、底部参数槽（可选） |
| Artifact 声明 | `artifactClaims` | 必填、纯数据：声明插件接受的扩展名 / MIME 类型与优先级 |
| V2 内容投影 | `projectArtifact(artifact)` | 可选纯函数：把 daemon 已验证的 artifact identity 与元数据投影为 `title` / `text` / `payload` / `meta` |
| 创建入口 | `creatable` | 缺省为 `true`；设为 `false` 时仅可承接产物投影，不进入创建菜单或首屏面板 |
| Legacy Run 投影 | `materializeRunResult(node, result)` | 旧插件模块残留字段；V2 UI 与 daemon 不调用 |
| 演示结果 | `demoResult(node, prompt)` | 原型阶段：指令完成后要合并进节点的补丁；返回 `null` 表示无内容变化 |

## 引擎为所有插件统一提供

- 节点外壳：头部（图标 + 标题 + 更多）、选中态、四个连接端口、缩放手柄
- 画布引擎：无限平移缩放、拖拽、连线 / 关系标签、框选组框
- 指令生命周期：`idle → generating → done`，摘要条、骨架屏、取消
- 状态递进约定：**节点创建时必须为空**，内容只在「提交 → 生成动画 → 完成」之后出现
- 指令面板骨架：附件 / 来源小窗、输入区、发送按钮（插件只填占位、快捷指令与参数槽）
- 结果结算：通用 artifact 对账、Agent 后续动作建议和刷新恢复由引擎统一处理；插件只做纯内容投影

## 扩展一个新类型

```tsx
import { FileVideo } from 'lucide-react'
import { registerPlugin } from '@/plugins/types'
import { makeEmptyView, MetaLines } from '@/plugins/shared'

registerPlugin({
  id: 'video',
  label: '视频',
  desc: '上传视频、提取关键帧与字幕',
  icon: FileVideo,
  defaultWidth: 320,
  initialPayload: () => ({}),
  isEmpty: (n) => !(n.meta ?? []).some((m) => !m.startsWith('✓')),
  views: {
    Empty: makeEmptyView(FileVideo, '拖入视频', '或执行指令解析'),
    Content: ({ node }) => (
      <div>
        <div className="flex h-[110px] items-center justify-center rounded-[10px] bg-gg-subtle">…</div>
        <MetaLines node={node} />
      </div>
    ),
    Artifact: ({ artifact, content }) => (
      <video
        controls
        src={artifact.url}
        aria-label={content.title ?? artifact.title}
        className="w-full rounded-[10px]"
      />
    ),
  },
  instr: {
    placeholder: '提取关键帧、转录字幕、总结内容…',
    actions: ['提取关键帧', '转录字幕', '总结内容'],
  },
  artifactClaims: [{
    extensions: ['.mp4', '.mov'],
    mediaTypes: ['video/*'],
    priority: 20,
  }],
  projectArtifact: ({ runId, artifactId, mediaType, size, contentDigest, title }) => ({
    title,
    meta: [mediaType, `${size} B`],
    payload: { artifactRef: { runId, artifactId, contentDigest } },
  }),
  // Legacy 字段；V2 UI 与 daemon 不调用。
  materializeRunResult: (_node, result) => {
    const videoPath = result.artifactFiles.find((file) => /\.(?:mp4|mov)$/iu.test(file))
    return videoPath ? { payload: { videoPath } } : null
  },
  demoResult: (n, prompt) => ({ title: 'clip.mp4', meta: ['02:31 · 1080p'] }),
})
```

注册后，可创建插件会出现在创建菜单与首屏面板。每次 V2 Run 启动前，浏览器把当前启用的
community data-only claims 注册给 daemon；daemon 返回固定 registry digest，并把该快照绑定到
整个 Run。后续插件热更新只影响新 Run，不会改变正在执行或恢复中的 artifact 分类。所有插件
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

浏览器通过 `PUT /plugin-capabilities/v2` 注册 claims；daemon 合并不可覆盖的内置 registry、
规范化并按 digest 保存到 `.gg/runtime/plugin-capabilities-v2/<digest>.json`。RunIntent 只引用
这个 digest；live Run 找不到或不能验证指定快照时拒绝启动，不以另一份 community registry
替代。浏览器只在 daemon 用 manifest 校验 `{ runId, artifactId }` 后，才调用 `projectArtifact`。
投影函数接收冻结的 `{ runId, artifactId, mediaType, size, contentDigest, title, url }`，只返回可
结构化克隆的 `NodeContentPatch`；随后由同一插件的 `views.Artifact` 渲染。`url` 仅供当前浏览器
读取，不写入 Canvas。投影函数拿不到 entity id、坐标、edges、commands 或 dispatcher，因此
不能创建节点、决定布局或修改图关系；函数与 renderer 也不会被序列化或传到 daemon。
`materializeRunResult` 仍存在于旧插件类型，但生产 UI 与 daemon 均为 V2-only，不读取它。

## 约定

- **生成优先（generation-first）**：这是 Agent 生成画布，不是资产柜。空态主行动是"描述需求，Agent 生成"；导入已有资产（拖文件、贴链接）只作为次要路径出现在辅助文案里
- 颜色只用设计令牌（`gg.*`），不引入渐变、不显示模型名与积分
- 视图组件保持"内容优先"：插件只渲染主体区，外壳与状态条不归插件管
- `payload` 结构由插件自定，持久化时随节点保存；避免引用引擎内部字段
- `artifactClaims` 必须是 JSON 可序列化数据；不要放函数、renderer、正则表达式或运行时对象
- `instr.actions` / `actionsFor` 是无结构化 Agent 结果时的 UI 兜底；成功 run 返回的上下文建议会优先展示
- 节点来源以 `Edge` 为唯一事实源；`instruction.sources` 仅保留为旧数据兼容镜像，插件不应读写它
