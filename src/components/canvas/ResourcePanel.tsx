import { useSyncExternalStore } from 'react'
import {
  FolderOpen, RefreshCw, HardDrive, Server, Boxes, ChevronRight,
  Sparkles, type LucideIcon,
} from 'lucide-react'
import { listPlugins, listEnabledPlugins, subscribePlugins } from '@/plugins/types'

interface RowProps {
  icon: LucideIcon
  title: string
  desc: string
  soon?: boolean
  onClick?: () => void
  trailing?: React.ReactNode
}

function Row({ icon: Icon, title, desc, soon, onClick, trailing }: RowProps) {
  const clickable = !!onClick && !soon
  return (
    <button
      disabled={!clickable}
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-[10px] px-2 py-2 text-left transition-colors ${
        clickable ? 'hover:bg-gg-subtle' : 'cursor-default opacity-60'
      }`}
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] bg-gg-subtle text-gg-primary">
        <Icon size={15} strokeWidth={1.9} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-gg-ink">
          {title}
          {soon && (
            <span className="rounded-full border border-gg-line px-1.5 py-px text-[10px] text-gg-muted">
              规划中
            </span>
          )}
        </span>
        <span className="block truncate text-[11px] leading-4 text-gg-muted">{desc}</span>
      </span>
      {trailing ??
        (clickable && <ChevronRight size={14} className="shrink-0 text-gg-muted" />)}
    </button>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="px-1.5 pt-3">
      <p className="px-2 pb-1 text-[11px] font-medium tracking-wide text-gg-muted">{title}</p>
      <div className="space-y-0.5">{children}</div>
    </div>
  )
}

/** 资源中心：文件 / 同步 / 算力 / 插件 的统一入口面板 */
export default function ResourcePanel({ onOpenPlugins }: { onOpenPlugins: () => void }) {
  // 订阅插件注册表，让计数实时刷新
  useSyncExternalStore(subscribePlugins, () => 0)
  const total = listPlugins().length
  const enabled = listEnabledPlugins().length

  return (
    <div className="absolute bottom-3 left-[60px] top-[64px] z-30 flex w-[248px] flex-col overflow-hidden rounded-[14px] border border-gg-line bg-gg-node shadow-float">
      <div className="border-b border-gg-line px-3.5 py-2.5">
        <p className="text-[13px] font-medium text-gg-ink">资源</p>
        <p className="text-[11px] leading-4 text-gg-muted">文件、算力与节点能力的统一入口</p>
      </div>

      <div className="flex-1 overflow-y-auto pb-3">
        <Section title="文件与数据">
          <Row icon={FolderOpen} title="项目文件" desc="画布引用的文件与素材" soon />
          <Row icon={RefreshCw} title="同步" desc="跨设备同步与版本快照" soon />
          <Row icon={HardDrive} title="文件系统" desc="挂载本地目录 / 网盘" soon />
        </Section>

        <Section title="算力">
          <Row icon={Boxes} title="计算集群" desc="接入集群跑批量生成任务" soon />
          <Row icon={Server} title="服务器" desc="远程服务器与部署目标" soon />
        </Section>

        <Section title="能力">
          <Row
            icon={Sparkles}
            title="节点插件"
            desc="画布节点类型，全部以插件形式管理"
            onClick={onOpenPlugins}
            trailing={
              <span className="flex shrink-0 items-center gap-1.5">
                <span className="rounded-full bg-gg-subtle px-1.5 py-px text-[10.5px] text-gg-ink">
                  {enabled}/{total} 启用
                </span>
                <ChevronRight size={14} className="text-gg-muted" />
              </span>
            }
          />
        </Section>
      </div>
    </div>
  )
}
