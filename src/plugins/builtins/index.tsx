/**
 * 内置节点插件：pdf / web / image / text / table / formula / code / graphic / smart。
 * 与社区插件完全同构——它们只是"系统自带的插件"，没有任何特权。
 * 新类型要加入画布，照此写一个 NodePlugin 并 registerPlugin 即可。
 */
import { useState } from 'react'
import {
  Eye, FileText, Link2, Image as ImageIcon, Pencil, Type, Table2, Sigma, Code2, Shapes, Sparkles, Globe,
} from 'lucide-react'
import { useCanvas } from '@/hooks/useCanvasStore'
import type { CanvasNode } from '@/types/canvas'
import {
  registerPlugin,
  unregisterPlugin,
  type NodePlugin,
  type NodeViewProps,
} from '../types'
import { artifactClaimsForBuiltinV2 } from '../artifactContracts'
import { makeEmptyView, MetaLines } from '../shared'
import { MarkdownView } from '../markdown'
import SmartChart from '@/components/canvas/SmartChart'
import { artifactUrl } from '@/agent/config'

const hasMeta = (n: CanvasNode) => (n.meta ?? []).some((m) => !m.startsWith('✓'))
const hasText = (n: CanvasNode) => Boolean(n.text?.trim())
const hasImageArtifact = (n: CanvasNode) => Array.isArray(n.payload?.artifactFiles)
  && n.payload.artifactFiles.some((file) =>
    typeof file === 'string' && /\.(?:png|jpe?g|webp|gif|svg)$/iu.test(file))
const contentNote = (prompt: string) =>
  `✓ 已完成：${(prompt || '指令').slice(0, 18)}${prompt.length > 18 ? '…' : ''}`
const materializeResponseText: NonNullable<NodePlugin['materializeRunResult']> = (_node, result) =>
  result.responseText.trim() ? { text: result.responseText } : null

/* ---------------- PDF / 文件 ---------------- */
function PdfContent({ node }: NodeViewProps) {
  return (
    <div>
      <div className="flex h-[86px] items-center justify-center rounded-[10px] bg-gg-subtle">
        <FileText size={26} className="text-gg-muted" strokeWidth={1.4} />
      </div>
      <MetaLines node={node} />
    </div>
  )
}

const pdfPlugin: NodePlugin = {
  id: 'pdf', label: 'PDF / 文件', desc: '让 Agent 检索、解析文献与文件', icon: FileText,
  defaultWidth: 300, initialPayload: () => ({}), isEmpty: (n) => !hasMeta(n),
  views: { Empty: makeEmptyView(FileText, '拖入文件', '或描述需求，Agent 检索并解析文献'), Content: PdfContent },
  instr: {
    placeholder: '对这个文件提问，或让它提取图表、总结章节…',
    actions: ['总结要点', '提取图表', '提取方法', '翻译', '基于内容提问'],
  },
  artifactClaims: artifactClaimsForBuiltinV2('pdf'),
  demoResult: (n) => hasMeta(n)
    ? { meta: [...(n.meta ?? []).filter((m) => !m.startsWith('✓')), contentNote(n.instruction.prompt)] }
    : { title: '文献综述 · Agent 整理', meta: ['Agent 检索 3 篇相关文献', '已提取 6 图 · 4 表 · 12 章节'] },
}

/* ---------------- 网页链接 ---------------- */
function WebContent({ node }: NodeViewProps) {
  return (
    <div>
      <div className="flex items-center gap-2 rounded-[10px] bg-gg-subtle px-3 py-2.5">
        <Globe size={14} className="shrink-0 text-gg-muted" />
        <span className="truncate text-[12px] text-gg-primary">{node.title}</span>
      </div>
      <MetaLines node={node} />
    </div>
  )
}

const webPlugin: NodePlugin = {
  id: 'web', label: '网页链接', desc: '让 Agent 抓取、检索网页资料', icon: Link2,
  defaultWidth: 300, initialPayload: () => ({}), isEmpty: (n) => !hasMeta(n),
  views: { Empty: makeEmptyView(Globe, '粘贴链接', '或描述主题，Agent 检索相关页面'), Content: WebContent },
  instr: {
    placeholder: '总结这个页面，或提取其中的关键信息…',
    actions: ['总结页面', '提取要点', '翻译'],
  },
  artifactClaims: [],
  demoResult: (n) => hasMeta(n)
    ? { meta: [...(n.meta ?? []).filter((m) => !m.startsWith('✓')), contentNote(n.instruction.prompt)] }
    : { title: '主题检索 · Agent 整理', meta: ['Agent 检索 4 个相关页面', '已抓取摘要与关键数据'] },
}

/* ---------------- 图像 ---------------- */
function ImageContent({ node }: NodeViewProps) {
  const files = Array.isArray(node.payload?.artifactFiles)
    ? node.payload.artifactFiles.filter((entry): entry is string => typeof entry === 'string')
    : []
  const imagePath = files.find((file) => /\.(?:png|jpe?g|webp|gif|svg)$/iu.test(file))
  return (
    <div>
      {imagePath ? (
        <img
          src={artifactUrl(imagePath)}
          alt={node.title || 'Agent 生成图像'}
          className="h-auto max-h-[260px] w-full rounded-[10px] bg-gg-subtle object-contain"
          draggable={false}
          data-no-drag
        />
      ) : (
        <div className="flex h-[110px] flex-col items-center justify-center gap-1.5 rounded-[10px] bg-gg-subtle">
          <ImageIcon size={24} className="text-gg-muted" strokeWidth={1.4} />
          <span className="text-[10.5px] text-gg-muted">图像产物</span>
        </div>
      )}
      <MetaLines node={node} />
    </div>
  )
}

const imagePlugin: NodePlugin = {
  id: 'image', label: '图像', desc: '输入提示词，Agent 生成图像', icon: ImageIcon,
  defaultWidth: 300, initialPayload: () => ({}), isEmpty: (n) => !hasMeta(n) && !hasImageArtifact(n),
  views: { Empty: makeEmptyView(ImageIcon, '描述并生成图像', '在指令区输入提示词，也可以拖入现有图像'), Content: ImageContent },
  instr: {
    placeholder: '描述想要的图像，例如：线粒体自噬机制示意图，简洁学术风…',
    actions: ['生成图像', '更换风格', '生成变体', '提高分辨率'],
  },
  artifactClaims: artifactClaimsForBuiltinV2('image'),
  demoResult: (n) => hasMeta(n)
    ? { meta: [...(n.meta ?? []).filter((m) => !m.startsWith('✓')), contentNote(n.instruction.prompt)] }
    : { title: '生成的图像', meta: ['Agent 生成 · 1920 × 1080', `提示词：${(n.instruction.prompt || '机制示意图').slice(0, 20)}`] },
}

/* ---------------- 文本 ---------------- */
function TextEmpty({ node, selected }: NodeViewProps) {
  const { updateNode } = useCanvas()
  const sizeCls = node.heading === 1 ? 'text-[19px] font-semibold' : node.heading === 2 ? 'text-[16px] font-semibold' : 'text-[13.5px]'
  return selected ? (
    <textarea
      data-no-drag
      value={node.text ?? ''}
      onChange={(e) => updateNode(node.id, { text: e.target.value })}
      placeholder="输入文本，或在下方指令区让它生成…"
      className={`w-full resize-none rounded-[8px] bg-transparent leading-6 text-gg-ink outline-none placeholder:text-[#98A2B3] ${sizeCls}`}
      rows={2}
    />
  ) : (
    <p className={`whitespace-pre-wrap leading-6 text-[#98A2B3] ${sizeCls}`}>
      空白文本 · 选中后输入或用指令生成
    </p>
  )
}

function TextContent({ node, selected }: NodeViewProps) {
  const { updateNode } = useCanvas()
  // 选中态默认编辑原文；点右上角切换 Markdown 预览。未选中（阅读态）始终渲染预览。
  const [preview, setPreview] = useState(false)
  const sizeCls = node.heading === 1 ? 'text-[19px] font-semibold' : node.heading === 2 ? 'text-[16px] font-semibold' : 'text-[13.5px]'
  const style: React.CSSProperties = {
    fontWeight: node.bold ? 600 : undefined,
    fontStyle: node.italic ? 'italic' : undefined,
  }
  if (!selected) {
    return <MarkdownView text={node.text ?? ''} className={sizeCls} style={style} />
  }
  return (
    <div className="relative">
      <button
        data-no-drag
        type="button"
        title={preview ? '编辑原文' : '预览排版'}
        aria-label={preview ? '编辑原文' : '预览排版'}
        onClick={() => setPreview((value) => !value)}
        className="absolute -top-1 right-0 z-10 flex h-5 w-5 items-center justify-center rounded-[6px] text-gg-muted transition-colors hover:bg-gg-subtle hover:text-gg-ink"
      >
        {preview ? <Pencil size={11} /> : <Eye size={11} />}
      </button>
      {preview ? (
        <MarkdownView text={node.text ?? ''} className={sizeCls} style={style} />
      ) : (
        <textarea
          data-no-drag
          value={node.text ?? ''}
          onChange={(e) => updateNode(node.id, { text: e.target.value })}
          placeholder="输入文本，或在下方指令区让它生成…"
          className={`w-full resize-none rounded-[8px] bg-transparent leading-6 text-gg-ink outline-none placeholder:text-[#98A2B3] ${sizeCls}`}
          style={style}
          rows={Math.max(2, Math.ceil((node.text?.length ?? 0) / 22))}
        />
      )}
    </div>
  )
}

const textPlugin: NodePlugin = {
  id: 'text', label: '文本', desc: '描述主题，Agent 撰写与改写', icon: Type,
  defaultWidth: 320, initialPayload: () => ({}), isEmpty: (n) => !hasText(n),
  views: { Empty: TextEmpty, Content: TextContent },
  instr: {
    placeholder: '一句话，振奋人心，但是简短有力。',
    actions: [],
    /**
     * 改写类预设指令依赖上下文：节点自身有产物，或引用了带文本的来源节点时才出现。
     * 空白且无来源的第一个节点不显示，避免指令脱离上下文。
     */
    actionsFor: (node, sources) =>
      hasText(node) || sources.some(hasText)
        ? ['改写', '缩短', '扩写', '改变语气', '生成标题']
        : [],
  },
  artifactClaims: artifactClaimsForBuiltinV2('text'),
  materializeRunResult: materializeResponseText,
  demoResult: (n) => {
    const p = n.instruction.prompt
    const text = n.text ?? ''
    if (!hasText(n)) return { text: p || '前路虽远，步履不停，终抵星辰。' }
    if (p.includes('缩短')) return { text: text.slice(0, 12) + '…' }
    if (p.includes('扩写')) return { text: text + ' 道阻且长，行则将至；心之所向，素履以往。' }
    if (p.includes('标题')) return { title: '星辰与步履' }
    if (p.includes('语气')) return { text: '路虽远，行则必至，一起加油。' }
    if (p.includes('改写')) return { text: '长路漫漫，惟行不止，终将抵达属于自己的星辰。' }
    if (p.includes('提炼')) return { text: '核心观点：坚持长期主义，行动胜过空想。' }
    if (p.includes('转为图形')) {
      return { meta: [...(n.meta ?? []).filter((m) => !m.startsWith('✓')), '✓ 已生成图形草稿（见来源链）'] }
    }
    return null
  },
}

/* ---------------- 表格 / 数据 ---------------- */
function TableContent({ node }: NodeViewProps) {
  return (
    <div>
      <table className="w-full border-collapse text-[11.5px]">
        <thead>
          <tr>
            {['模型', '准确率', '召回率'].map((h) => (
              <th key={h} className="border border-gg-line bg-gg-subtle px-2 py-1.5 text-left font-medium text-gg-ink">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[['Baseline', '0.812', '0.768'], ['Ours', '0.894', '0.861'], ['Ablation', '0.847', '0.802']].map((row) => (
            <tr key={row[0]}>
              {row.map((c) => <td key={c} className="border border-gg-line px-2 py-1.5 text-gg-muted">{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      <MetaLines node={node} />
    </div>
  )
}

const tablePlugin: NodePlugin = {
  id: 'table', label: '表格 / 数据', desc: '描述数据结构，Agent 生成表格', icon: Table2,
  defaultWidth: 340, initialPayload: () => ({}), isEmpty: (n) => !hasMeta(n),
  views: { Empty: makeEmptyView(Table2, '描述并生成表格', '也可以拖入 CSV / Excel 让 Agent 分析'), Content: TableContent },
  instr: {
    placeholder: '清洗数据、做可视化、分析趋势…',
    actions: ['清洗数据', '可视化', '趋势分析', '生成摘要'],
  },
  artifactClaims: artifactClaimsForBuiltinV2('table'),
  demoResult: (n) => hasMeta(n)
    ? { meta: [...(n.meta ?? []).filter((m) => !m.startsWith('✓')), contentNote(n.instruction.prompt)] }
    : { title: '模型性能对比 · Agent 生成', meta: ['3 行 · 3 列 · 示例数据'] },
}

/* ---------------- 公式 ---------------- */
function FormulaContent({ node }: NodeViewProps) {
  return (
    <div>
      <div className="flex min-h-[64px] items-center justify-center rounded-[10px] bg-gg-subtle px-3 py-4">
        <span className="font-serif text-[16px] italic tracking-wide text-gg-ink">{node.text}</span>
      </div>
      <MetaLines node={node} />
    </div>
  )
}

const formulaPlugin: NodePlugin = {
  id: 'formula', label: '公式', desc: '描述问题，Agent 推导公式', icon: Sigma,
  defaultWidth: 300, initialPayload: () => ({}), isEmpty: (n) => !hasText(n),
  views: { Empty: makeEmptyView(Sigma, '描述并推导公式', '也可以直接输入已有公式'), Content: FormulaContent },
  instr: {
    placeholder: '解释这个公式，或转为可运行的代码…',
    actions: ['解释公式', '化简', '转为代码'],
  },
  artifactClaims: [],
  materializeRunResult: materializeResponseText,
  demoResult: (n) => hasText(n)
    ? { meta: [...(n.meta ?? []).filter((m) => !m.startsWith('✓')), contentNote(n.instruction.prompt)] }
    : { text: 'L(θ) = − Σᵢ log p(yᵢ | xᵢ; θ)' },
}

/* ---------------- 代码 ---------------- */
function CodeContent({ node }: NodeViewProps) {
  return (
    <div>
      <pre className="overflow-x-auto rounded-[10px] bg-gg-subtle p-3 font-mono text-[11.5px] leading-5 text-gg-ink">
        {node.text}
      </pre>
      <MetaLines node={node} />
    </div>
  )
}

const codePlugin: NodePlugin = {
  id: 'code', label: '代码', desc: '描述需求，Agent 编写代码', icon: Code2,
  defaultWidth: 340, initialPayload: () => ({}), isEmpty: (n) => !hasText(n),
  views: { Empty: makeEmptyView(Code2, '描述并生成代码', '也可以直接粘贴已有代码'), Content: CodeContent },
  instr: {
    placeholder: '解释、重构这段代码，或补充注释…',
    actions: ['解释代码', '重构', '添加注释', '修复问题'],
  },
  artifactClaims: artifactClaimsForBuiltinV2('code'),
  materializeRunResult: materializeResponseText,
  demoResult: (n) => hasText(n)
    ? { meta: [...(n.meta ?? []).filter((m) => !m.startsWith('✓')), contentNote(n.instruction.prompt)] }
    : { title: 'analysis.py', text: 'import pandas as pd\n\ndf = pd.read_csv("results.csv")\ndf.groupby("model").mean()' },
}

/* ---------------- 图形 / 画布 ---------------- */
function GraphicContent({ node }: NodeViewProps) {
  return (
    <div>
      <div className="flex h-[100px] items-center justify-center rounded-[10px] bg-gg-subtle">
        <svg width="150" height="70" viewBox="0 0 150 70">
          <rect x="6" y="10" width="42" height="24" rx="5" fill="#fff" stroke="#1769E0" strokeWidth="1.5" />
          <circle cx="98" cy="22" r="13" fill="#fff" stroke="#B8C4D4" strokeWidth="1.5" />
          <path d="M 48 22 L 82 22" stroke="#B8C4D4" strokeWidth="1.5" />
          <rect x="34" y="46" width="80" height="14" rx="4" fill="#fff" stroke="#B8C4D4" strokeWidth="1.5" />
        </svg>
      </div>
      <MetaLines node={node} />
    </div>
  )
}

const graphicPlugin: NodePlugin = {
  id: 'graphic', label: '图形 / 画布', desc: '描述图形，Agent 绘制可编辑图形', icon: Shapes,
  defaultWidth: 300, initialPayload: () => ({}), isEmpty: (n) => !hasMeta(n),
  views: { Empty: makeEmptyView(Shapes, '描述并绘制图形', '也可以手动开始绘制'), Content: GraphicContent },
  instr: {
    placeholder: '生成变体、调整风格…',
    actions: ['生成变体', '调整配色', '提取样式'],
  },
  artifactClaims: [],
  demoResult: (n) => hasMeta(n)
    ? { meta: [...(n.meta ?? []).filter((m) => !m.startsWith('✓')), contentNote(n.instruction.prompt)] }
    : { title: '流程示意图 · Agent 绘制', meta: ['可编辑图形 · 3 图层'] },
}

/* ---------------- 智能节点（通用型） ---------------- */
function SmartEmpty() {
  return (
    <div className="flex h-[120px] flex-col items-center justify-center gap-1.5 rounded-[10px] border border-dashed border-gg-line">
      <span className="text-[12px] text-gg-muted">产物区</span>
      <span className="text-[11px] text-[#98A2B3]">在下方指令区描述需求并执行</span>
    </div>
  )
}

function SmartContent({ node }: NodeViewProps) {
  if (!node.smart) return null
  return (
    <div className="rounded-[10px] border border-gg-line bg-white p-2">
      <SmartChart smart={node.smart} />
      <p className="mt-1 px-1 text-[11px] text-gg-muted">
        {node.smart.chartType} · {node.smart.style}风格
        {node.instruction.prompt
          ? ` · 「${node.instruction.prompt.slice(0, 16)}${node.instruction.prompt.length > 16 ? '…' : ''}」`
          : ''}
      </p>
    </div>
  )
}

/** 智能节点的参数槽：图表类型 / 风格 / 张数（渲染在指令面板底部控制条） */
const SEL_CLS =
  'h-7 cursor-pointer appearance-none rounded-full border border-gg-line bg-white bg-[url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2210%22 height=%226%22%3E%3Cpath d=%22M1 1l4 4 4-4%22 stroke=%22%23667085%22 fill=%22none%22 stroke-width=%221.5%22 stroke-linecap=%22round%22/%3E%3C/svg%3E")] bg-[position:right_9px_center] bg-no-repeat py-0 pl-2.5 pr-6 text-[11.5px] text-gg-ink outline-none focus:border-gg-select'

function SmartParamSlot({ node }: { node: CanvasNode }) {
  const { updateSmart } = useCanvas()
  if (!node.smart) return null
  return (
    <>
      <select
        value={node.smart.chartType}
        onChange={(e) => updateSmart(node.id, { chartType: e.target.value as typeof node.smart.chartType })}
        className={SEL_CLS}
      >
        {['柱状图', '折线图', '面积图'].map((o) => <option key={o}>{o}</option>)}
      </select>
      <select
        value={node.smart.style}
        onChange={(e) => updateSmart(node.id, { style: e.target.value as typeof node.smart.style })}
        className={SEL_CLS}
      >
        {['简洁', '学术', '信息图'].map((o) => <option key={o}>{o}</option>)}
      </select>
      <select
        value={node.smart.count}
        onChange={(e) => updateSmart(node.id, { count: Number(e.target.value) })}
        className={SEL_CLS}
      >
        {[1, 2, 3, 4].map((o) => <option key={o} value={o}>{o} 张</option>)}
      </select>
    </>
  )
}

const smartPlugin: NodePlugin = {
  id: 'smart', label: '智能节点', desc: '接受指令并生成产物', icon: Sparkles,
  defaultWidth: 360,
  initialPayload: () => ({ smart: { chartType: '柱状图', style: '简洁', count: 1, seed: 1 } }),
  // 产物存在与否看指令生命周期：done 之后即有产物
  isEmpty: (n) => n.instruction.phase === 'idle',
  views: { Empty: SmartEmpty, Content: SmartContent },
  instr: {
    placeholder: '描述要生成的产物，例如：根据来源数据画一张对比柱状图',
    actions: [], // 通用型：不给固定动作
    ParamSlot: SmartParamSlot,
  },
  artifactClaims: [],
  demoResult: () => null, // 产物由 SmartChart 依据参数渲染
}

/* ---------------- 注册（顺序即创建菜单顺序） ---------------- */
const builtinPlugins = [
  pdfPlugin,
  webPlugin,
  imagePlugin,
  textPlugin,
  tablePlugin,
  formulaPlugin,
  codePlugin,
  graphicPlugin,
  smartPlugin,
] as const

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
