import {
  ArrowLeft,
  ArrowRight,
  Check,
  ExternalLink,
  Layers3,
  MonitorDot,
  ShieldCheck,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import catalogJson from '../../ui-render/scenarios.json'
import type {
  UiRenderCatalog,
  UiRenderScenarioCatalogEntry,
} from './catalog'

const catalog = catalogJson as UiRenderCatalog

export default function UiRenderLab() {
  const initialId = new URL(globalThis.location.href).searchParams.get('focus')
  const initialScenario = catalog.scenarios.find((scenario) => scenario.id === initialId)
    ?? catalog.scenarios[0]!
  const [scenarioId, setScenarioId] = useState(initialScenario.id)
  const scenario = catalog.scenarios.find((candidate) => candidate.id === scenarioId)
    ?? initialScenario
  const journey = catalog.journeys.find((candidate) => candidate.id === scenario.journeyId)!
  const journeyScenarios = useMemo(() => catalog.scenarios
    .filter((candidate) => candidate.journeyId === scenario.journeyId)
    .sort((left, right) => left.step - right.step), [scenario.journeyId])
  const scenarioIndex = journeyScenarios.findIndex((candidate) => candidate.id === scenario.id)
  const principles = scenario.principleIds.map((principleId) => catalog.principles
    .find((candidate) => candidate.id === principleId)!).filter(Boolean)
  const previewScale = scenario.viewport.width > 1000 ? 0.62 : 0.82

  const selectScenario = (next: UiRenderScenarioCatalogEntry) => {
    setScenarioId(next.id)
    const url = new URL(globalThis.location.href)
    url.searchParams.delete('scenario')
    url.searchParams.set('focus', next.id)
    globalThis.history.replaceState(null, '', url)
  }

  return (
    <div
      data-testid="ui-render-lab"
      className="flex h-screen min-w-[1180px] flex-col overflow-hidden bg-gg-bg font-sans text-gg-ink"
    >
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-gg-line bg-white px-4">
        <span className="flex h-8 w-8 items-center justify-center rounded-[9px] bg-[#EAF1FD] text-gg-primary">
          <MonitorDot size={16} aria-hidden="true" />
        </span>
        <div>
          <h1 className="text-[14px] font-semibold">本地 UI 状态实验室</h1>
          <p className="text-[10.5px] text-gg-muted">生产组件 · 确定性状态 · 设计契约 · 本地即时反馈</p>
        </div>
        <div className="ml-4 flex items-center gap-2 text-[10.5px] text-gg-muted">
          <span className="rounded-full bg-gg-subtle px-2.5 py-1">{catalog.journeys.length} 条状态旅程</span>
          <span className="rounded-full bg-gg-subtle px-2.5 py-1">{catalog.scenarios.length} 个查验场景</span>
        </div>
        <a
          href={`./index.html?scenario=${encodeURIComponent(scenario.id)}`}
          target="_blank"
          rel="noreferrer"
          className="ml-auto flex h-8 items-center gap-1.5 rounded-[9px] border border-gg-line px-3 text-[11px] text-gg-muted outline-none hover:border-gg-primary/40 hover:text-gg-primary focus-visible:ring-2 focus-visible:ring-gg-primary/30"
        >
          <ExternalLink size={12} aria-hidden="true" />
          独立打开精确画布
        </a>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="w-[280px] shrink-0 overflow-y-auto border-r border-gg-line bg-white p-3">
          <div className="mb-3 flex items-center gap-2 px-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-gg-muted">
            <Layers3 size={12} aria-hidden="true" />
            状态旅程
          </div>
          <nav aria-label="UI 状态场景" className="space-y-4">
            {catalog.journeys.map((candidateJourney) => {
              const entries = catalog.scenarios
                .filter((candidate) => candidate.journeyId === candidateJourney.id)
                .sort((left, right) => left.step - right.step)
              return (
                <section key={candidateJourney.id} aria-labelledby={`journey-${candidateJourney.id}`}>
                  <div className="px-2">
                    <h2 id={`journey-${candidateJourney.id}`} className="text-[11.5px] font-semibold">
                      {candidateJourney.label}
                    </h2>
                    <p className="mt-0.5 text-[9.5px] leading-4 text-gg-muted">
                      {candidateJourney.description}
                    </p>
                  </div>
                  <ol className="mt-2 space-y-1">
                    {entries.map((entry) => {
                      const selected = entry.id === scenario.id
                      return (
                        <li key={entry.id}>
                          <button
                            type="button"
                            aria-current={selected ? 'step' : undefined}
                            onClick={() => selectScenario(entry)}
                            className={`flex w-full items-start gap-2 rounded-[9px] px-2.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-gg-primary/30 ${
                              selected ? 'bg-[#EAF1FD] text-gg-primary' : 'hover:bg-gg-subtle'
                            }`}
                          >
                            <span className={`mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold ${
                              selected ? 'bg-gg-primary text-white' : 'bg-gg-subtle text-gg-muted'
                            }`}>{entry.step}</span>
                            <span className="min-w-0">
                              <span className="block text-[10.5px] font-medium leading-4">{entry.title}</span>
                              <span className="mt-0.5 block truncate text-[9px] text-gg-muted">{entry.state.phase} · {entry.state.disclosure}</span>
                            </span>
                          </button>
                        </li>
                      )
                    })}
                  </ol>
                </section>
              )
            })}
          </nav>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-16 shrink-0 items-center gap-3 border-b border-gg-line bg-white px-5">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[10px] text-gg-muted">
                <span>{journey.label}</span>
                <span>·</span>
                <span>步骤 {scenario.step}/{journeyScenarios.length}</span>
                <span>·</span>
                <span>{scenario.viewport.width} × {scenario.viewport.height}</span>
              </div>
              <h2 className="mt-1 truncate text-[14px] font-semibold">{scenario.title}</h2>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label="上一个状态"
                disabled={scenarioIndex <= 0}
                onClick={() => selectScenario(journeyScenarios[scenarioIndex - 1]!)}
                className="flex h-8 w-8 items-center justify-center rounded-[8px] border border-gg-line text-gg-muted outline-none hover:text-gg-ink disabled:opacity-35 focus-visible:ring-2 focus-visible:ring-gg-primary/30"
              >
                <ArrowLeft size={13} aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label="下一个状态"
                disabled={scenarioIndex >= journeyScenarios.length - 1}
                onClick={() => selectScenario(journeyScenarios[scenarioIndex + 1]!)}
                className="flex h-8 w-8 items-center justify-center rounded-[8px] border border-gg-line text-gg-muted outline-none hover:text-gg-ink disabled:opacity-35 focus-visible:ring-2 focus-visible:ring-gg-primary/30"
              >
                <ArrowRight size={13} aria-hidden="true" />
              </button>
            </div>
          </div>

          <div className="relative min-h-0 flex-1 overflow-auto p-6">
            <div
              className="mx-auto overflow-hidden rounded-[16px] border border-gg-line bg-white shadow-sm"
              style={{
                width: scenario.viewport.width * previewScale,
                height: scenario.viewport.height * previewScale,
              }}
            >
              <iframe
                key={scenario.id}
                title={`${scenario.title}精确预览`}
                src={`./index.html?scenario=${encodeURIComponent(scenario.id)}`}
                style={{
                  width: scenario.viewport.width,
                  height: scenario.viewport.height,
                  border: 0,
                  transform: `scale(${previewScale})`,
                  transformOrigin: 'top left',
                }}
              />
            </div>
          </div>
        </main>

        <aside className="w-[310px] shrink-0 overflow-y-auto border-l border-gg-line bg-white p-4">
          <p className="text-[12.5px] font-semibold">状态契约</p>
          <p className="mt-1 text-[10px] leading-4 text-gg-muted">{scenario.description}</p>

          <dl className="mt-4 grid grid-cols-[82px_1fr] gap-x-3 gap-y-2 rounded-[12px] bg-gg-subtle p-3 text-[10.5px]">
            <dt className="text-gg-muted">生命周期</dt><dd className="font-medium">{scenario.state.phase}</dd>
            <dt className="text-gg-muted">视觉选择</dt><dd className="font-medium">{scenario.state.selection}</dd>
            <dt className="text-gg-muted">控制归属</dt><dd className="font-medium">{scenario.state.controlOwner}</dd>
            <dt className="text-gg-muted">披露层级</dt><dd className="font-medium">{scenario.state.disclosure}</dd>
          </dl>

          <section className="mt-5">
            <h3 className="flex items-center gap-1.5 text-[11px] font-semibold">
              <ShieldCheck size={13} className="text-gg-primary" aria-hidden="true" />
              设计原则
            </h3>
            <ul className="mt-2 space-y-2">
              {principles.map((principle) => (
                <li key={principle.id} className="rounded-[10px] border border-gg-line px-3 py-2">
                  <p className="text-[10.5px] font-medium">{principle.label}</p>
                  <p className="mt-0.5 text-[9.5px] leading-4 text-gg-muted">{principle.description}</p>
                </li>
              ))}
            </ul>
          </section>

          <section className="mt-5">
            <h3 className="text-[11px] font-semibold">人工查验重点</h3>
            <ul className="mt-2 space-y-2">
              {scenario.checkpoints.map((checkpoint) => (
                <li key={checkpoint} className="flex items-start gap-2 text-[10px] leading-4 text-gg-muted">
                  <Check size={11} className="mt-0.5 shrink-0 text-gg-success" aria-hidden="true" />
                  {checkpoint}
                </li>
              ))}
            </ul>
          </section>

          <section className="mt-5 border-t border-gg-line pt-4">
            <h3 className="text-[11px] font-semibold">自动契约</h3>
            <p className="mt-1 text-[9.5px] leading-4 text-gg-muted">
              本场景有 {scenario.checks.length} 项 DOM/文案检查，截图前自动执行；失败时不会生成“看似正常”的记录。
            </p>
          </section>
        </aside>
      </div>
    </div>
  )
}
