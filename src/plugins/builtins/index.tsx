/** Built-ins use the same data-only UI contract as installed Node definitions. */
import { artifactClaimsForBuiltin } from '@/plugins/artifactContracts'
import { nodeContextPolicyForBuiltin } from '@/plugins/contextContracts'
import {
  registerPlugin,
  unregisterPlugin,
  type NodeTypeDefinition,
} from '@/plugins/types'
import { defineNodeUi } from '@/plugins/uiContracts'
import { NODE_TYPE_DEFINITION_SCHEMA_VERSION } from '@/plugins/nodeTypeContracts'

const builtinPlugins: readonly NodeTypeDefinition[] = [
  builtin({
    id: 'pdf', label: 'PDF / 文件', description: '让 Agent 检索、解析文献与文件', icon: 'pdf',
    defaultWidth: 300,
    ui: defineNodeUi('file'),
    instruction: { placeholder: '对这个文件提问，或让它提取图表、总结章节…', actions: [], marks: [] },
    nodeContext: nodeContextPolicyForBuiltin('pdf'),
    artifactClaims: artifactClaimsForBuiltin('pdf'),
  }),
  builtin({
    id: 'web', label: '网页链接', description: '让 Agent 抓取、检索网页资料', icon: 'web',
    defaultWidth: 300,
    ui: defineNodeUi('link'),
    instruction: { placeholder: '总结这个页面，或提取其中的关键信息…', actions: [], marks: [] },
    nodeContext: nodeContextPolicyForBuiltin('web'),
    artifactClaims: [],
  }),
  builtin({
    id: 'image', label: '图像', description: '输入提示词，Agent 生成图像', icon: 'image',
    defaultWidth: 300,
    ui: defineNodeUi('media'),
    instruction: { placeholder: '描述想要的图像…', actions: [], marks: [] },
    nodeContext: nodeContextPolicyForBuiltin('image'),
    artifactClaims: artifactClaimsForBuiltin('image'),
  }),
  builtin({
    id: 'text', label: '文本', description: '描述主题，Agent 撰写与改写', icon: 'text',
    defaultWidth: 320,
    ui: defineNodeUi('document'),
    instruction: {
      placeholder: '一句话，振奋人心，但是简短有力。',
      actions: [],
      marks: [
        { id: 'bold', title: '粗体', icon: 'bold', payloadKey: 'bold', value: true },
        { id: 'italic', title: '斜体', icon: 'italic', payloadKey: 'italic', value: true },
        { id: 'h1', title: '标题 1', icon: 'heading-1', payloadKey: 'heading', value: 1, exclusiveGroup: 'heading' },
        { id: 'h2', title: '标题 2', icon: 'heading-2', payloadKey: 'heading', value: 2, exclusiveGroup: 'heading' },
      ],
    },
    ports: [
      { key: 'content-in', direction: 'input', schema: 'ggai://value/text', cardinality: 'one' },
      { key: 'content', direction: 'output', schema: 'ggai://value/text', cardinality: 'one', materialization: 'tray' },
    ],
    nodeContext: nodeContextPolicyForBuiltin('text'),
    artifactClaims: artifactClaimsForBuiltin('text'),
  }),
  builtin({
    id: 'table', label: '表格 / 数据', description: '描述数据结构，Agent 生成表格', icon: 'table',
    defaultWidth: 340,
    ui: defineNodeUi('table'),
    instruction: { placeholder: '清洗数据、做可视化、分析趋势…', actions: [], marks: [] },
    nodeContext: nodeContextPolicyForBuiltin('table'),
    artifactClaims: artifactClaimsForBuiltin('table'),
  }),
  builtin({
    id: 'formula', label: '公式', description: '描述问题，Agent 推导公式', icon: 'formula',
    defaultWidth: 300,
    ui: defineNodeUi('formula'),
    instruction: { placeholder: '解释这个公式，或转为可运行的代码…', actions: [], marks: [] },
    nodeContext: nodeContextPolicyForBuiltin('formula'),
    artifactClaims: [],
  }),
  builtin({
    id: 'code', label: '代码', description: '描述需求，Agent 编写代码', icon: 'code',
    defaultWidth: 340,
    ui: defineNodeUi('code'),
    instruction: { placeholder: '解释、重构这段代码，或补充注释…', actions: [], marks: [] },
    nodeContext: nodeContextPolicyForBuiltin('code'),
    artifactClaims: artifactClaimsForBuiltin('code'),
  }),
  builtin({
    id: 'graphic', label: '图形 / 画布', description: '描述图形，Agent 绘制可编辑图形', icon: 'graphic',
    defaultWidth: 300,
    ui: defineNodeUi('card'),
    instruction: { placeholder: '描述要生成的图形…', actions: [], marks: [] },
    nodeContext: nodeContextPolicyForBuiltin('graphic'),
    artifactClaims: [],
  }),
  builtin({
    id: 'smart', label: '智能节点', description: '接受指令并生成产物', icon: 'smart',
    defaultWidth: 360,
    ui: defineNodeUi('card'),
    instruction: { placeholder: '描述要生成的产物…', actions: [], marks: [] },
    execution: { capability: 'smart', policy: 'trusted-provider' },
    ports: [{
      key: 'result', direction: 'output', schema: 'ggai://value/json',
      cardinality: 'many', materialization: 'tray',
    }],
    nodeContext: nodeContextPolicyForBuiltin('smart'),
    artifactClaims: [],
  }),
  builtin({
    id: 'group', label: '组合', description: '在局部坐标系中组织可编辑子节点', icon: 'card',
    defaultWidth: 480,
    ui: defineNodeUi('card'),
    instruction: { placeholder: '描述这个组合要承载的内容…', actions: [], marks: [] },
    containment: { canHaveChildren: true, allowedChildTypes: [], maxDepth: 32 },
    nodeContext: nodeContextPolicyForBuiltin('smart'),
    artifactClaims: [],
  }),
  builtin({
    id: 'file', label: '文件', description: '未识别产物的安全通用视图', icon: 'file',
    creatable: false, defaultWidth: 320,
    ui: defineNodeUi('file'),
    instruction: { placeholder: '基于这个文件创建派生任务…', actions: [], marks: [] },
    nodeContext: nodeContextPolicyForBuiltin('file'),
    artifactClaims: artifactClaimsForBuiltin('file'),
  }),
]

function builtin(
  input: Pick<
    NodeTypeDefinition,
    | 'id'
    | 'label'
    | 'description'
    | 'icon'
    | 'defaultWidth'
    | 'ui'
    | 'instruction'
    | 'nodeContext'
    | 'artifactClaims'
  > & {
    creatable?: boolean
    containment?: NodeTypeDefinition['containment']
    ports?: NodeTypeDefinition['ports']
    execution?: NodeTypeDefinition['execution']
  },
): NodeTypeDefinition {
  const creatable = input.creatable ?? true
  return {
    schemaVersion: NODE_TYPE_DEFINITION_SCHEMA_VERSION,
    revision: 1,
    creatable,
    initialPayloadSchema: 'ggai://schema/payload/open',
    initialPayload: {},
    containment: { canHaveChildren: false, allowedChildTypes: [], maxDepth: 0 },
    ports: [],
    exporters: [],
    agent: {
      constructible: creatable,
      ...(creatable ? { writableInitSchema: 'ggai://schema/payload/open' } : {}),
    },
    ...input,
  }
}

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
