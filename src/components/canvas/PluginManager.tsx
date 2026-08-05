import { useState, useSyncExternalStore } from 'react'
import {
  Download, FlaskConical, Plus, Search, Sparkles, ToggleLeft, ToggleRight, X,
} from 'lucide-react'
import { useCanvas } from '@/hooks/useCanvasStore'
import {
  listPlugins, subscribePlugins, setPluginEnabled, isPluginEnabled, type NodePlugin,
} from '@/plugins/types'

const BUILTIN_IDS = ['pdf', 'web', 'image', 'text', 'table', 'formula', 'code', 'graphic', 'smart']

interface CommunityItem {
  id: string
  label: string
  desc: string
  author: string
  installs: string
}

/** 社区节点（原型占位数据，仅用于演示安装交互） */
const COMMUNITY: CommunityItem[] = [
  { id: 'video', label: '视频', desc: '上传视频、提取关键帧与字幕', author: '@ggai-lab', installs: '2.4k' },
  { id: 'audio', label: '音频', desc: '播客、访谈录音、转录摘要', author: '@muse', installs: '1.8k' },
  { id: 'mindmap', label: '思维导图', desc: '层级梳理、大纲自动成图', author: '@nodesmith', installs: '3.1k' },
  { id: 'chart3d', label: '3D 图表', desc: '曲面、散点云、参数可交互', author: '@vizworks', installs: '986' },
  { id: 'dataset', label: '数据集', desc: '连接 HuggingFace / Kaggle 数据集', author: '@datalink', installs: '1.2k' },
  { id: 'latex', label: 'LaTeX 文档', desc: '整篇论文的结构化编辑与编译', author: '@typset', installs: '764' },
]

export default function PluginManager({ onClose }: { onClose: () => void }) {
  const { addNode, camera } = useCanvas()
  useSyncExternalStore(subscribePlugins, () => 0)
  const [tab, setTab] = useState<'installed' | 'community'>('installed')
  const [q, setQ] = useState('')
  const [installedIds, setInstalledIds] = useState<Set<string>>(new Set())
  const [justInstalled, setJustInstalled] = useState<string | null>(null)

  const plugins = listPlugins()
  const kw = q.trim()

  const filtered = plugins.filter((p) =>
    !kw || p.label.toLowerCase().includes(kw.toLowerCase()) || p.desc.includes(kw))
  const filteredCommunity = COMMUNITY.filter((c) =>
    !installedIds.has(c.id) &&
    (!kw || c.label.toLowerCase().includes(kw.toLowerCase()) || c.desc.includes(kw)))

  const tryIt = (p: NodePlugin) => {
    // 「试用一下」：直接在当前视口中心放一个该类型的空白节点
    const wx = (window.innerWidth / 2 - camera.x) / camera.zoom - p.defaultWidth / 2 + 60
    const wy = (window.innerHeight / 2 - camera.y) / camera.zoom - 60
    addNode(p.id, wx, wy)
    onClose()
  }

  const install = (c: CommunityItem) => {
    setInstalledIds((s) => new Set(s).add(c.id))
    setJustInstalled(c.id)
    setTimeout(() => setJustInstalled(null), 1800)
  }

  return (
    <div className="absolute inset-0 z-50" onPointerDown={onClose}>
      {/* 遮罩 */}
      <div className="absolute inset-0 bg-[#1C2533]/20 backdrop-blur-[1px]" />
      {/* 面板 */}
      <div
        className="gg-pop absolute left-1/2 top-1/2 flex h-[520px] w-[680px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[18px] border border-gg-line bg-gg-bg shadow-float"
        onPointerDown={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center gap-3 border-b border-gg-line bg-gg-node px-5 py-3.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-[#EAF1FD] text-gg-primary">
            <Sparkles size={16} />
          </div>
          <div className="flex-1">
            <p className="text-[14px] font-semibold text-gg-ink">节点插件</p>
            <p className="text-[11.5px] text-gg-muted">画布的节点类型都是插件 —— 管理、试用、从社区安装</p>
          </div>
          {/* 搜索 */}
          <div className="flex h-8 w-[200px] items-center gap-1.5 rounded-full border border-gg-line bg-white px-3">
            <Search size={13} className="text-gg-muted" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索节点类型…"
              className="w-full bg-transparent text-[12.5px] text-gg-ink outline-none placeholder:text-[#98A2B3]"
            />
          </div>
          {/* 标签页 */}
          <div className="flex rounded-full border border-gg-line bg-white p-0.5">
            {([['installed', '已安装'], ['community', '社区']] as const).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                className={`rounded-full px-3.5 py-1.5 text-[12px] transition-colors ${
                  tab === k ? 'bg-gg-primary text-white' : 'text-gg-muted hover:text-gg-ink'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full text-gg-muted transition-colors hover:bg-gg-subtle hover:text-gg-ink"
          >
            <X size={15} />
          </button>
        </div>

        {/* 内容 */}
        <div className="flex-1 overflow-y-auto p-4">
          {tab === 'installed' ? (
            <div className="grid grid-cols-3 gap-3">
              {filtered.map((p) => {
                const Icon = p.icon
                const enabled = isPluginEnabled(p.id)
                const isBuiltin = BUILTIN_IDS.includes(p.id)
                return (
                  <div
                    key={p.id}
                    className={`group relative flex flex-col rounded-[14px] border bg-gg-node p-3.5 transition-all ${
                      enabled ? 'border-gg-line hover:border-gg-select hover:shadow-float' : 'border-gg-line opacity-70'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className={`flex h-8 w-8 items-center justify-center rounded-[9px] transition-colors ${
                        enabled ? 'bg-[#EAF1FD] text-gg-primary' : 'bg-gg-subtle text-gg-muted'
                      }`}>
                        <Icon size={15} strokeWidth={1.8} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[12.5px] font-medium text-gg-ink">{p.label}</p>
                        <p className="text-[10.5px] text-[#98A2B3]">{isBuiltin ? '内置' : '社区'} · v0.1</p>
                      </div>
                    </div>
                    <p className="mt-2 line-clamp-2 min-h-[28px] text-[11px] leading-3.5 text-gg-muted">{p.desc}</p>
                    {p.instr.actions.length > 0 && (
                      <p className="mt-1 truncate text-[10.5px] text-[#98A2B3]">
                        快捷指令：{p.instr.actions.slice(0, 3).join(' / ')}
                      </p>
                    )}
                    <div className="mt-2.5 flex items-center gap-1.5">
                      <button
                        onClick={() => tryIt(p)}
                        disabled={!enabled}
                        className="flex h-7 flex-1 items-center justify-center gap-1 rounded-[8px] bg-gg-primary text-[11.5px] font-medium text-white transition-colors hover:bg-[#0F5BD0] disabled:bg-gg-subtle disabled:text-[#98A2B3]"
                      >
                        <FlaskConical size={12} /> 试用一下
                      </button>
                      <button
                        title={enabled ? '停用（不再出现在创建菜单）' : '启用'}
                        onClick={() => setPluginEnabled(p.id, !enabled)}
                        className={`flex h-7 w-9 items-center justify-center rounded-[8px] transition-colors ${
                          enabled ? 'text-gg-primary hover:bg-[#EAF1FD]' : 'text-[#98A2B3] hover:bg-gg-subtle'
                        }`}
                      >
                        {enabled ? <ToggleRight size={18} /> : <ToggleLeft size={18} />}
                      </button>
                    </div>
                  </div>
                )
              })}
              {/* 新建自定义插件入口卡 */}
              <button className="flex min-h-[132px] flex-col items-center justify-center gap-1.5 rounded-[14px] border border-dashed border-gg-line text-gg-muted transition-colors hover:border-gg-select hover:text-gg-primary">
                <Plus size={18} />
                <span className="text-[12px]">创建自定义节点</span>
                <span className="px-4 text-center text-[10.5px] leading-3.5 text-[#98A2B3]">
                  按插件规范定义身份、视图与指令
                </span>
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {filteredCommunity.map((c) => {
                const installed = installedIds.has(c.id)
                const just = justInstalled === c.id
                return (
                  <div
                    key={c.id}
                    className={`flex items-center gap-3 rounded-[14px] border bg-gg-node p-3.5 transition-all ${
                      just ? 'border-gg-success' : 'border-gg-line hover:border-gg-select hover:shadow-float'
                    }`}
                  >
                    <span className={`flex h-10 w-10 items-center justify-center rounded-[10px] transition-colors ${
                      just ? 'bg-[#E7F6EF] text-gg-success' : 'bg-gg-subtle text-gg-muted'
                    }`}>
                      <Sparkles size={17} strokeWidth={1.8} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="flex items-baseline gap-1.5 text-[12.5px] font-medium text-gg-ink">
                        {c.label}
                        <span className="text-[10.5px] font-normal text-[#98A2B3]">{c.author}</span>
                      </p>
                      <p className="truncate text-[11px] text-gg-muted">{c.desc}</p>
                      <p className="mt-0.5 text-[10.5px] text-[#98A2B3]">{c.installs} 次安装</p>
                    </div>
                    <button
                      onClick={() => install(c)}
                      disabled={installed}
                      className={`flex h-8 w-[76px] shrink-0 items-center justify-center gap-1 rounded-full text-[11.5px] font-medium transition-all ${
                        just
                          ? 'bg-gg-success text-white'
                          : installed
                            ? 'bg-gg-subtle text-[#98A2B3]'
                            : 'bg-gg-primary text-white hover:bg-[#0F5BD0]'
                      }`}
                    >
                      {just ? '✓ 已安装' : installed ? '已安装' : <><Download size={12} /> 安装</>}
                    </button>
                  </div>
                )
              })}
              {filteredCommunity.length === 0 && (
                <p className="col-span-2 py-10 text-center text-[12.5px] text-gg-muted">
                  {kw ? '没有匹配的社区节点' : '社区节点都安装好啦'}
                </p>
              )}
            </div>
          )}
        </div>

        {/* 底部 */}
        <div className="border-t border-gg-line bg-gg-node px-5 py-2.5">
          <p className="text-[11px] text-gg-muted">
            内置节点也是插件，同样受这套规范管理 · 详见 <span className="font-mono text-gg-ink">src/plugins/README.md</span>
          </p>
        </div>
      </div>
    </div>
  )
}
