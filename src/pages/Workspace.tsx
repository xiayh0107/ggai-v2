import { useState } from 'react'
import { Link } from 'react-router'
import {
  Home, Compass, LayoutGrid, FolderOpen, Settings, Search, Plus, Ellipsis,
  Bell, MessagesSquare, ChevronDown, Database, FileText, Workflow, LineChart, FlaskConical,
} from 'lucide-react'
import { ThumbBars, ThumbMito, ThumbSankey } from '@/components/home/Thumbs'

const NAV = [
  { key: 'workspace', label: '工作空间', icon: Home, active: true },
  { key: 'discover', label: '发现灵感', icon: Compass },
  { key: 'templates', label: '模板中心', icon: LayoutGrid },
  { key: 'assets', label: '资源库', icon: FolderOpen },
  { key: 'settings', label: '设置', icon: Settings },
]

const PROJECTS = [
  { title: '线粒体自噬机制图', tag: '生物学', tagColor: '#22A06B', time: '昨天 16:45', Thumb: ThumbMito },
  { title: '药物A vs 药物B 疗效对比', tag: '药理学', tagColor: '#1769E0', time: '昨天 10:30', Thumb: ThumbBars },
  { title: '全球碳排放流向 1990–2020', tag: '环境科学', tagColor: '#7C6FCE', time: '3 天前', Thumb: ThumbSankey },
]

const RECENT = [
  { title: '单细胞测序实验流程图', tag: '生物学', tagColor: '#22A06B', time: '昨天 10:30', icon: Workflow },
  { title: 'NF-κB 信号通路综述图（文献生成）', tag: '生物学', tagColor: '#22A06B', time: '昨天 09:15', icon: FileText },
  { title: '实验数据趋势分析', tag: '数据分析', tagColor: '#1769E0', time: '2 天前', icon: LineChart },
  { title: '细胞培养方案流程图', tag: '生物学', tagColor: '#22A06B', time: '上周五', icon: FlaskConical },
]

export default function Workspace() {
  const [tab, setTab] = useState<'个人' | '团队项目'>('个人')
  const [nav, setNav] = useState('workspace')

  return (
    <div className="flex h-screen w-screen flex-col bg-gg-bg font-sans">
      {/* 顶部品牌栏 */}
      <header className="flex h-[56px] shrink-0 items-center justify-between border-b border-gg-line bg-gg-node px-5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-[9px] bg-gg-primary text-[14px] font-semibold text-white">G</div>
          <div>
            <p className="text-[14.5px] font-semibold leading-4 text-gg-ink">GGAI</p>
            <p className="text-[10.5px] leading-3 text-gg-muted">Generative Graphics AI</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5 text-[12.5px] text-gg-muted">
            <Database size={14} /> 1200
          </span>
          <button className="flex items-center gap-1.5 text-[12.5px] text-gg-muted transition-colors hover:text-gg-ink">
            <MessagesSquare size={15} /> 社区
          </button>
          <button className="text-gg-muted transition-colors hover:text-gg-ink"><Bell size={16} /></button>
          <button className="flex items-center gap-1">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-gg-ink text-[12px] font-medium text-white">Z</span>
            <ChevronDown size={13} className="text-gg-muted" />
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* 左侧导航 */}
        <nav className="flex w-[180px] shrink-0 flex-col gap-0.5 border-r border-gg-line bg-gg-node p-3">
          {NAV.map(({ key, label, icon: Icon, active }) => (
            <button
              key={key}
              onClick={() => setNav(key)}
              className={`flex items-center gap-2.5 rounded-[10px] px-3 py-2 text-left text-[13px] transition-colors ${
                nav === key
                  ? 'bg-[#EAF1FD] font-medium text-gg-primary'
                  : 'text-gg-ink hover:bg-gg-subtle'
              }`}
            >
              <Icon size={15} strokeWidth={1.8} className={nav === key ? 'text-gg-primary' : 'text-gg-muted'} />
              {label}
              {active && nav === key && null}
            </button>
          ))}
        </nav>

        {/* 主区 */}
        <main className="min-w-0 flex-1 overflow-y-auto px-8 pb-12 pt-6">
          {/* 标签 + 搜索 + 新建 */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex gap-5">
              {(['个人', '团队项目'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`border-b-2 pb-2 text-[14px] transition-colors ${
                    tab === t ? 'border-gg-primary font-medium text-gg-ink' : 'border-transparent text-gg-muted hover:text-gg-ink'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-[300px] items-center gap-2 rounded-[10px] border border-gg-line bg-gg-node px-3">
                <Search size={14} className="text-gg-muted" />
                <input
                  placeholder="搜索项目、关键字或标签"
                  className="w-full bg-transparent text-[12.5px] text-gg-ink outline-none placeholder:text-[#98A2B3]"
                />
              </div>
              <Link
                to="/canvas"
                className="flex h-9 items-center gap-1.5 rounded-[10px] bg-gg-primary px-4 text-[13px] font-medium text-white transition-colors hover:bg-gg-select"
              >
                <Plus size={15} /> 新建项目
              </Link>
            </div>
          </div>

          {/* 继续工作 */}
          <h2 className="mt-7 text-[15px] font-semibold text-gg-ink">继续工作</h2>
          <div className="mt-3.5 grid grid-cols-3 gap-4 max-[1200px]:grid-cols-2">
            {PROJECTS.map(({ title, tag, tagColor, time, Thumb }) => (
              <Link
                key={title}
                to="/canvas"
                className="group overflow-hidden rounded-[14px] border border-gg-line bg-gg-node transition-all duration-150 hover:-translate-y-0.5 hover:border-gg-select hover:shadow-float"
              >
                <div className="aspect-[340/150] overflow-hidden border-b border-gg-line">
                    <Thumb />
                </div>
                <div className="px-4 py-3">
                  <div className="flex items-center justify-between">
                    <p className="truncate text-[13.5px] font-medium text-gg-ink">{title}</p>
                    <Ellipsis size={15} className="shrink-0 text-gg-muted opacity-0 transition-opacity group-hover:opacity-100" />
                  </div>
                  <div className="mt-1.5 flex items-center gap-3 text-[11.5px] text-gg-muted">
                    <span className="flex items-center gap-1">
                      <span className="h-1.5 w-1.5 rounded-full" style={{ background: tagColor }} />
                      {tag}
                    </span>
                    <span>{time}</span>
                  </div>
                </div>
              </Link>
            ))}
          </div>

          {/* 最近打开 */}
          <h2 className="mt-8 text-[15px] font-semibold text-gg-ink">最近打开</h2>
          <div className="mt-3 overflow-hidden rounded-[14px] border border-gg-line bg-gg-node">
            {RECENT.map(({ title, tag, tagColor, time, icon: Icon }, i) => (
              <Link
                key={title}
                to="/canvas"
                className={`flex items-center gap-3 px-4 py-3 transition-colors hover:bg-gg-subtle ${
                  i > 0 ? 'border-t border-gg-line' : ''
                }`}
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-gg-subtle text-gg-muted">
                  <Icon size={15} strokeWidth={1.8} />
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-gg-ink">{title}</span>
                <span className="flex w-[110px] items-center gap-1.5 text-[11.5px] text-gg-muted">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: tagColor }} />
                  {tag}
                </span>
                <span className="w-[90px] text-right text-[11.5px] text-gg-muted">{time}</span>
                <Ellipsis size={15} className="text-gg-muted" />
              </Link>
            ))}
          </div>
        </main>
      </div>
    </div>
  )
}
