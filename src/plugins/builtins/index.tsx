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
    id: 'compute', label: '计算', description: '在隔离、无网络的 digest-pinned 容器中运行代码', icon: 'code',
    defaultWidth: 420,
    initialPayloadSchema: 'ggai://schema/payload/compute',
    initialPayload: {
      runtime: 'python-3.13',
      code: [
        'import json',
        'from pathlib import Path',
        "Path('/outputs/result.txt').write_text('hello\\n', encoding='utf-8')",
        "Path('/outputs/execution-result.json').write_text(json.dumps({'schemaVersion': 1, 'outputs': {'result': [{'path': 'result.txt'}]}}), encoding='utf-8')",
      ].join('\n'),
      timeoutMs: 60_000,
      memoryMb: 512,
      cpus: 1,
      pids: 64,
    },
    ui: defineNodeUi('code'),
    instruction: { placeholder: '编写需要在隔离容器中运行的代码…', actions: [], marks: [] },
    execution: { capability: 'container-compute', policy: 'digest-approval' },
    ports: [
      { key: 'data', direction: 'input', schema: 'ggai://value/json', cardinality: 'many' },
      { key: 'files', direction: 'input', schema: 'ggai://value/artifact', cardinality: 'many' },
      { key: 'result', direction: 'output', schema: 'ggai://value/artifact', cardinality: 'many', materialization: 'tray' },
    ],
    nodeContext: nodeContextPolicyForBuiltin('code'),
    artifactClaims: artifactClaimsForBuiltin('code'),
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
    id: 'asset-assembly', label: '素材组合', description: '组合可编辑素材并生成确定性 PNG / SVG', icon: 'graphic',
    defaultWidth: 480,
    initialPayloadSchema: 'ggai://schema/payload/asset-assembly',
    initialPayload: { background: '#ffffff00', density: 144 },
    ui: defineNodeUi('card'),
    instruction: { placeholder: '添加素材部件和形状，组合新的视觉素材…', actions: [], marks: [] },
    containment: { canHaveChildren: true, allowedChildTypes: ['asset-part', 'shape'], maxDepth: 32 },
    execution: { capability: 'asset-assembly', policy: 'trusted-provider' },
    ports: [
      { key: 'png', direction: 'output', schema: 'ggai://value/image', cardinality: 'one', materialization: 'tray' },
      { key: 'svg', direction: 'output', schema: 'ggai://value/image', cardinality: 'one', materialization: 'tray' },
    ],
    exporters: ['rasterizer'],
    nodeContext: nodeContextPolicyForBuiltin('smart'),
    artifactClaims: [],
  }),
  builtin({
    id: 'asset-part', label: '素材部件', description: '引用单一可信素材的可编辑图层', icon: 'image',
    defaultWidth: 300,
    initialPayloadSchema: 'ggai://schema/payload/asset-part',
    initialPayload: {
      sourceRect: { x: 0, y: 0, w: 300, h: 200 },
      pivot: { x: 0, y: 0 }, opacity: 1, blend: 'normal', alt: '',
    },
    ui: defineNodeUi('media'),
    instruction: { placeholder: '描述这个素材部件的用途…', actions: [], marks: [] },
    nodeContext: nodeContextPolicyForBuiltin('image'),
    artifactClaims: artifactClaimsForBuiltin('image'),
  }),
  builtin({
    id: 'shape', label: '形状', description: '素材组合中的声明式可编辑形状', icon: 'graphic',
    defaultWidth: 300,
    initialPayloadSchema: 'ggai://schema/payload/shape',
    initialPayload: {
      kind: 'rectangle', fill: '#d9e5ff', stroke: 'transparent', strokeWidth: 0, cornerRadius: 12,
    },
    ui: defineNodeUi('card'),
    instruction: { placeholder: '设置形状的外观…', actions: [], marks: [] },
    exporters: ['rasterizer'],
    nodeContext: nodeContextPolicyForBuiltin('graphic'),
    artifactClaims: [],
  }),
  builtin({
    id: 'project', label: '项目目录', description: '通过 opaque workspace root 浏览已授权目录', icon: 'card',
    defaultWidth: 420,
    initialPayloadSchema: 'ggai://schema/payload/filesystem-entry',
    initialPayload: { rootId: '', relativePath: '' },
    ui: defineNodeUi('file'),
    instruction: { placeholder: '浏览或固定这个工作区根目录中的内容…', actions: [], marks: [] },
    containment: { canHaveChildren: true, allowedChildTypes: ['directory', 'file'], maxDepth: 32 },
    nodeContext: nodeContextPolicyForBuiltin('file'),
    artifactClaims: [],
  }),
  builtin({
    id: 'directory', label: '目录', description: '按需展开的工作区目录，不自动生成子节点', icon: 'file',
    defaultWidth: 360,
    initialPayloadSchema: 'ggai://schema/payload/filesystem-entry',
    initialPayload: { rootId: '', relativePath: '' },
    ui: defineNodeUi('file'),
    instruction: { placeholder: '浏览或固定这个目录中的文件…', actions: [], marks: [] },
    containment: { canHaveChildren: true, allowedChildTypes: ['directory', 'file'], maxDepth: 32 },
    nodeContext: nodeContextPolicyForBuiltin('file'),
    artifactClaims: [],
  }),
  builtin({
    id: 'file', label: '文件', description: '未识别产物的安全通用视图', icon: 'file',
    creatable: false, defaultWidth: 320,
    initialPayloadSchema: 'ggai://schema/payload/filesystem-entry',
    initialPayload: { rootId: '', relativePath: '' },
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
    exporters?: NodeTypeDefinition['exporters']
    initialPayloadSchema?: NodeTypeDefinition['initialPayloadSchema']
    initialPayload?: NodeTypeDefinition['initialPayload']
  },
): NodeTypeDefinition {
  const creatable = input.creatable ?? true
  return {
    schemaVersion: NODE_TYPE_DEFINITION_SCHEMA_VERSION,
    revision: 1,
    creatable,
    initialPayloadSchema: input.initialPayloadSchema ?? 'ggai://schema/payload/open',
    initialPayload: input.initialPayload ?? {},
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
