import { useSyncExternalStore } from 'react'
import {
  getPluginRegistryVersion,
  listCreatablePlugins,
  nodeTypeIcon,
  subscribePlugins,
} from '@/plugins/types'

export interface CanvasCreateNodeMenuProps {
  x: number
  y: number
  sourceTitle?: string
  onSelect: (pluginId: string) => void
}

/** Plugin-backed creation menu. Stage supplies placement; the menu owns registry presentation. */
export default function CanvasCreateNodeMenu({
  x,
  y,
  sourceTitle,
  onSelect,
}: CanvasCreateNodeMenuProps) {
  useSyncExternalStore(subscribePlugins, getPluginRegistryVersion, getPluginRegistryVersion)
  return (
    <div
      data-create-node-menu
      data-no-drag
      role="menu"
      aria-label="创建节点"
      className="absolute z-50 w-[200px] select-none rounded-[14px] border border-gg-line bg-gg-node p-1.5 shadow-float"
      style={{ left: x, top: y }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <p className="px-2.5 pb-1.5 pt-2 text-[11px] font-medium text-gg-muted">
        {sourceTitle ? `从“${sourceTitle}”新建节点` : '创建节点'}
      </p>
      {listCreatablePlugins().map((plugin) => {
        const Icon = nodeTypeIcon(plugin)
        return (
          <button
            key={plugin.id}
            type="button"
            role="menuitem"
            onClick={() => onSelect(plugin.id)}
            className="flex w-full items-center gap-2.5 rounded-[9px] px-2.5 py-[7px] text-left text-[12.5px] text-gg-ink outline-none transition-colors hover:bg-gg-subtle focus-visible:ring-2 focus-visible:ring-gg-primary/35"
          >
            <Icon size={14} className="text-gg-muted" strokeWidth={1.8} aria-hidden="true" />
            {plugin.label}
          </button>
        )
      })}
    </div>
  )
}
