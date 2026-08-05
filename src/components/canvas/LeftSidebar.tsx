import { useState } from 'react'
import {
  Plus, Search, FolderOpen, ListTree, MessageSquare, History, type LucideIcon,
} from 'lucide-react'
import { useCanvas } from '@/hooks/useCanvasStore'
import PluginManager from './PluginManager'
import ResourcePanel from './ResourcePanel'

interface Item { key: string; label: string; icon: LucideIcon }

const ITEMS: Item[] = [
  { key: 'create', label: '创建节点', icon: Plus },
  { key: 'search', label: '搜索', icon: Search },
  { key: 'assets', label: '资源', icon: FolderOpen },
  { key: 'outline', label: '大纲', icon: ListTree },
  { key: 'comments', label: '评论', icon: MessageSquare },
  { key: 'history', label: '历史', icon: History },
]

export default function LeftSidebar() {
  const { nodes, openCreateMenu, camera, fitView, select } = useCanvas()
  const [panel, setPanel] = useState<string | null>(null)
  const [pluginMgrOpen, setPluginMgrOpen] = useState(false)

  const onClick = (key: string) => {
    if (key === 'create') {
      // 从全局入口创建：菜单出现在左侧栏旁，落在画布可视区中心偏左
      const sx = 76
      const sy = 160
      openCreateMenu({ sx, sy, wx: (240 - camera.x) / camera.zoom, wy: (220 - camera.y) / camera.zoom })
      setPanel(null)
      return
    }
    setPanel((p) => (p === key ? null : key))
  }

  return (
    <>
      <nav className="absolute bottom-0 left-0 top-[52px] z-30 flex w-[52px] flex-col items-center gap-1 border-r border-gg-line bg-gg-node py-3">
        {ITEMS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            title={label}
            onClick={() => onClick(key)}
            className={`flex h-9 w-9 items-center justify-center rounded-[10px] transition-colors ${
              panel === key ? 'bg-gg-subtle text-gg-primary' : 'text-gg-muted hover:bg-gg-subtle hover:text-gg-ink'
            }`}
          >
            <Icon size={17} strokeWidth={1.8} />
          </button>
        ))}
      </nav>

      {/* 大纲面板：列出画布节点，点击定位 */}
      {panel === 'outline' && (
        <div className="absolute bottom-3 left-[60px] top-[64px] z-30 flex w-[220px] flex-col overflow-hidden rounded-[14px] border border-gg-line bg-gg-node shadow-float">
          <div className="border-b border-gg-line px-3 py-2.5 text-[13px] font-medium text-gg-ink">大纲</div>
          <div className="flex-1 overflow-y-auto p-1.5">
            {nodes.length === 0 && (
              <p className="px-2 py-6 text-center text-[12px] text-gg-muted">画布还没有节点</p>
            )}
            {nodes.map((n) => (
              <button
                key={n.id}
                onClick={() => { select(n.id); fitView() }}
                className="flex w-full items-center gap-2 rounded-[8px] px-2 py-1.5 text-left text-[12.5px] text-gg-ink hover:bg-gg-subtle"
              >
                <span className="truncate">{n.title || '未命名节点'}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 资源中心：文件 / 同步 / 算力 / 插件 的统一入口 */}
      {panel === 'assets' && (
        <ResourcePanel onOpenPlugins={() => { setPanel(null); setPluginMgrOpen(true) }} />
      )}

      {/* 插件管理：从资源中心进入的全屏交互面板 */}
      {pluginMgrOpen && <PluginManager onClose={() => setPluginMgrOpen(false)} />}

      {/* 其余面板为原型占位 */}
      {panel && panel !== 'outline' && panel !== 'assets' && (
        <div className="absolute left-[60px] top-[64px] z-30 w-[220px] rounded-[14px] border border-gg-line bg-gg-node p-4 shadow-float">
          <p className="text-[13px] font-medium text-gg-ink">
            {ITEMS.find((i) => i.key === panel)?.label}
          </p>
          <p className="mt-1 text-[12px] leading-5 text-gg-muted">该面板为原型占位，将在后续版本实现。</p>
        </div>
      )}
    </>
  )
}
