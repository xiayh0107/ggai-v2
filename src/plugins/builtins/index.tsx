/** Built-ins use the same data-only UI contract as installed Node definitions. */
import {
  Bold,
  Code2,
  File as FileIcon,
  FileText,
  Heading1,
  Heading2,
  Image as ImageIcon,
  Italic,
  Link2,
  Shapes,
  Sigma,
  Sparkles,
  Table2,
  Type,
} from 'lucide-react'
import { artifactClaimsForBuiltin } from '@/plugins/artifactContracts'
import { nodeContextPolicyForBuiltin } from '@/plugins/contextContracts'
import {
  registerPlugin,
  unregisterPlugin,
  type NodePlugin,
} from '@/plugins/types'
import { defineNodeUi } from '@/plugins/uiContracts'

function nodeHasContent(node: Parameters<NodePlugin['isEmpty']>[0]): boolean {
  return Boolean(
    node.text?.trim()
    || Object.keys(node.payload ?? {}).length > 0
    || node.artifactRefs.length > 0,
  )
}

const textMarks: NonNullable<NodePlugin['instr']['marksFor']> = (node) => {
  const payload = node.payload ?? {}
  return [
    { id: 'bold', title: '粗体', icon: Bold, active: payload.bold === true },
    { id: 'italic', title: '斜体', icon: Italic, active: payload.italic === true },
    { id: 'h1', title: '标题 1', icon: Heading1, active: payload.heading === 1 },
    { id: 'h2', title: '标题 2', icon: Heading2, active: payload.heading === 2 },
  ]
}

const toggleTextMark: NonNullable<NodePlugin['instr']['toggleMark']> = (node, markId) => {
  const payload: Record<string, unknown> = { ...(node.payload ?? {}) }
  const set = (key: string, value: unknown) => {
    if (value === undefined) delete payload[key]
    else payload[key] = value
  }
  if (markId === 'bold') set('bold', payload.bold === true ? undefined : true)
  else if (markId === 'italic') set('italic', payload.italic === true ? undefined : true)
  else if (markId === 'h1') set('heading', payload.heading === 1 ? undefined : 1)
  else if (markId === 'h2') set('heading', payload.heading === 2 ? undefined : 2)
  else return null
  return payload
}

const builtinPlugins: readonly NodePlugin[] = [
  {
    id: 'pdf', label: 'PDF / 文件', desc: '让 Agent 检索、解析文献与文件', icon: FileText,
    defaultWidth: 300, initialPayload: () => ({}), isEmpty: (node) => !nodeHasContent(node),
    ui: defineNodeUi('file'),
    instr: { placeholder: '对这个文件提问，或让它提取图表、总结章节…', actions: [] },
    nodeContext: nodeContextPolicyForBuiltin('pdf'),
    artifactClaims: artifactClaimsForBuiltin('pdf'),
  },
  {
    id: 'web', label: '网页链接', desc: '让 Agent 抓取、检索网页资料', icon: Link2,
    defaultWidth: 300, initialPayload: () => ({}), isEmpty: (node) => !nodeHasContent(node),
    ui: defineNodeUi('link'),
    instr: { placeholder: '总结这个页面，或提取其中的关键信息…', actions: [] },
    nodeContext: nodeContextPolicyForBuiltin('web'),
    artifactClaims: [],
  },
  {
    id: 'image', label: '图像', desc: '输入提示词，Agent 生成图像', icon: ImageIcon,
    defaultWidth: 300, initialPayload: () => ({}), isEmpty: (node) => !nodeHasContent(node),
    ui: defineNodeUi('media'),
    instr: { placeholder: '描述想要的图像…', actions: [] },
    nodeContext: nodeContextPolicyForBuiltin('image'),
    artifactClaims: artifactClaimsForBuiltin('image'),
  },
  {
    id: 'text', label: '文本', desc: '描述主题，Agent 撰写与改写', icon: Type,
    defaultWidth: 320, initialPayload: () => ({}), isEmpty: (node) => !nodeHasContent(node),
    ui: defineNodeUi('document'),
    instr: {
      placeholder: '一句话，振奋人心，但是简短有力。',
      actions: [],
      marksFor: textMarks,
      toggleMark: toggleTextMark,
    },
    nodeContext: nodeContextPolicyForBuiltin('text'),
    artifactClaims: artifactClaimsForBuiltin('text'),
  },
  {
    id: 'table', label: '表格 / 数据', desc: '描述数据结构，Agent 生成表格', icon: Table2,
    defaultWidth: 340, initialPayload: () => ({}), isEmpty: (node) => !nodeHasContent(node),
    ui: defineNodeUi('table'),
    instr: { placeholder: '清洗数据、做可视化、分析趋势…', actions: [] },
    nodeContext: nodeContextPolicyForBuiltin('table'),
    artifactClaims: artifactClaimsForBuiltin('table'),
  },
  {
    id: 'formula', label: '公式', desc: '描述问题，Agent 推导公式', icon: Sigma,
    defaultWidth: 300, initialPayload: () => ({}), isEmpty: (node) => !nodeHasContent(node),
    ui: defineNodeUi('formula'),
    instr: { placeholder: '解释这个公式，或转为可运行的代码…', actions: [] },
    nodeContext: nodeContextPolicyForBuiltin('formula'),
    artifactClaims: [],
  },
  {
    id: 'code', label: '代码', desc: '描述需求，Agent 编写代码', icon: Code2,
    defaultWidth: 340, initialPayload: () => ({}), isEmpty: (node) => !nodeHasContent(node),
    ui: defineNodeUi('code'),
    instr: { placeholder: '解释、重构这段代码，或补充注释…', actions: [] },
    nodeContext: nodeContextPolicyForBuiltin('code'),
    artifactClaims: artifactClaimsForBuiltin('code'),
  },
  {
    id: 'graphic', label: '图形 / 画布', desc: '描述图形，Agent 绘制可编辑图形', icon: Shapes,
    defaultWidth: 300, initialPayload: () => ({}), isEmpty: (node) => !nodeHasContent(node),
    ui: defineNodeUi('card'),
    instr: { placeholder: '描述要生成的图形…', actions: [] },
    nodeContext: nodeContextPolicyForBuiltin('graphic'),
    artifactClaims: [],
  },
  {
    id: 'smart', label: '智能节点', desc: '接受指令并生成产物', icon: Sparkles,
    defaultWidth: 360, initialPayload: () => ({}), isEmpty: (node) => !nodeHasContent(node),
    ui: defineNodeUi('card'),
    instr: { placeholder: '描述要生成的产物…', actions: [] },
    nodeContext: nodeContextPolicyForBuiltin('smart'),
    artifactClaims: [],
  },
  {
    id: 'file', label: '文件', desc: '未识别产物的安全通用视图', icon: FileIcon,
    creatable: false, defaultWidth: 320, initialPayload: () => ({}),
    isEmpty: (node) => !nodeHasContent(node),
    ui: defineNodeUi('file'),
    instr: { placeholder: '基于这个文件创建派生任务…', actions: [] },
    nodeContext: nodeContextPolicyForBuiltin('file'),
    artifactClaims: artifactClaimsForBuiltin('file'),
  },
]

let registered = false

export function registerBuiltinPlugins() {
  if (registered) return
  registered = true
  builtinPlugins.forEach(registerPlugin)
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    builtinPlugins.forEach((plugin) => unregisterPlugin(plugin.id))
    registered = false
  })
}
