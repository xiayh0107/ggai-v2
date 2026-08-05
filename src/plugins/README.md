# GGAI 节点插件规范（v0.1）

画布上的一切节点——包括 9 种内置类型——都以完全相同的插件形态存在。
内置插件（`builtins/`）与社区 / 用户插件能力对等，没有任何特权。

## 一个节点的基本要素

| 要素 | 字段 | 说明 |
| --- | --- | --- |
| 身份 | `id` / `label` / `desc` / `icon` | 全局唯一 id；社区插件建议带命名空间 `@author/video` |
| 几何 | `defaultWidth` | 创建时的缺省宽度（高度由内容自适应，引擎实测回填） |
| 内容契约 | `initialPayload()` + `isEmpty(node)` | 节点的本体数据结构与"空内容"判定；空 → 空白态，非空 → 内容态 |
| 视图 | `views.Empty` / `views.Content` | 两个 React 组件；生成中骨架屏由引擎统一接管，插件无需关心 |
| 指令配置 | `instr.placeholder` / `instr.actions` / `instr.actionsFor` / `instr.ParamSlot` | 输入占位、专属快捷指令、按节点内容与来源动态计算的上下文快捷指令（可选）、底部参数槽（可选） |
| Run 投影 | `materializeRunResult(node, result)` | 可选：把通用 Agent 文本与产物投影为本节点的 `text` / `payload` / `meta` |
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
  },
  instr: {
    placeholder: '提取关键帧、转录字幕、总结内容…',
    actions: ['提取关键帧', '转录字幕', '总结内容'],
  },
  materializeRunResult: (_node, result) => {
    const videoPath = result.artifactFiles.find((file) => /\.(?:mp4|mov)$/iu.test(file))
    return videoPath ? { payload: { videoPath } } : null
  },
  demoResult: (n, prompt) => ({ title: 'clip.mp4', meta: ['02:31 · 1080p'] }),
})
```

注册即生效：创建菜单、首屏平铺面板、来源小窗、连线、指令面板全部自动获得该类型。

## 约定

- **生成优先（generation-first）**：这是 Agent 生成画布，不是资产柜。空态主行动是"描述需求，Agent 生成"；导入已有资产（拖文件、贴链接）只作为次要路径出现在辅助文案里
- 颜色只用设计令牌（`gg.*`），不引入渐变、不显示模型名与积分
- 视图组件保持"内容优先"：插件只渲染主体区，外壳与状态条不归插件管
- `payload` 结构由插件自定，持久化时随节点保存；避免引用引擎内部字段
- `instr.actions` / `actionsFor` 是无结构化 Agent 结果时的 UI 兜底；成功 run 返回的上下文建议会优先展示
- 节点来源以 `Edge` 为唯一事实源；`instruction.sources` 仅保留为旧数据兼容镜像，插件不应读写它
