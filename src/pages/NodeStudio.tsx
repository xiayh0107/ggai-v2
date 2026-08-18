import { cloneElement, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { Link } from 'react-router'
import {
  ArrowLeft,
  Bot,
  Check,
  ChevronRight,
  CircleAlert,
  Download,
  Image,
  LayoutTemplate,
  Loader2,
  Plus,
  RotateCcw,
  Save,
  Sparkles,
  Table2,
  Trash2,
  Type,
  Wrench,
} from 'lucide-react'
import { DAEMON_URL } from '@/agent/config'
import type { CanvasNode } from '@/canvas/model'
import type { CanvasTaskStatus } from '@/canvas/selectors'
import CanvasNodeCard from '@/components/canvas/CanvasNodeCard'
import { NodeDefinitionClient, type NodeDefinitionApi } from '@/node-studio/client'
import {
  createBlankCustomNodeManifest,
  customNodeRuntimeId,
  draftCustomNodeFromRequirement,
  validateCustomNodeManifest,
  type CustomNodeContentKind,
  type CustomNodeManifest,
} from '@/node-studio/model'
import { createCustomNodeType, registerCustomNodeTypes } from '@/node-studio/runtime'
import type { PortDefinition } from '@/plugins/nodeTypeContracts'

type PreviewState = 'empty' | 'content' | 'running' | 'error'

const KIND_OPTIONS: Array<{ id: CustomNodeContentKind; label: string; icon: typeof Type }> = [
  { id: 'text', label: '文本', icon: Type },
  { id: 'image', label: '图像', icon: Image },
  { id: 'table', label: '表格', icon: Table2 },
  { id: 'card', label: '卡片', icon: LayoutTemplate },
]

export default function NodeStudio({ api: injectedApi }: { api?: NodeDefinitionApi } = {}) {
  const api = useMemo(() => injectedApi ?? new NodeDefinitionClient({ baseUrl: DAEMON_URL }), [injectedApi])
  const [definitions, setDefinitions] = useState<CustomNodeManifest[]>([])
  const [draft, setDraft] = useState(() => createBlankCustomNodeManifest())
  const [requirement, setRequirement] = useState('')
  const [previewState, setPreviewState] = useState<PreviewState>('content')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [agentStarting, setAgentStarting] = useState(false)
  const [agentCancelling, setAgentCancelling] = useState(false)
  const [agentRunId, setAgentRunId] = useState<string | null>(null)
  const [agentProgress, setAgentProgress] = useState<string | null>(null)
  const [agentCandidate, setAgentCandidate] = useState<CustomNodeManifest | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const agentStartingRef = useRef(false)

  const agentBusy = agentStarting || agentRunId !== null
  const studioLocked = agentBusy || agentCandidate !== null

  const latestDefinitions = useMemo(() => latestByPackage(definitions), [definitions])
  const validationErrors = useMemo(() => validateCustomNodeManifest(draft), [draft])
  const installedRevision = useMemo(() => definitions
    .filter((item) => item.id === draft.id && item.installed)
    .sort((left, right) => right.revision - left.revision)[0], [definitions, draft.id])

  useEffect(() => {
    const controller = new AbortController()
    abortRef.current = controller
    void api.list(controller.signal).then((items) => {
      if (controller.signal.aborted) return
      setDefinitions(items)
      const latest = latestByPackage(items)[0]
      if (latest) setDraft(latest)
      setLoading(false)
    }, (cause: unknown) => {
      if (controller.signal.aborted) return
      setError(cause instanceof Error ? cause.message : '节点定义加载失败')
      setLoading(false)
    })
    return () => controller.abort()
  }, [api])

  useEffect(() => {
    if (!agentRunId) return
    const controller = new AbortController()
    let timer: number | undefined
    let active = true
    const poll = async () => {
      try {
        const run = await api.getAgentRun(agentRunId, controller.signal)
        if (!active) return
        setAgentProgress(run.progress ?? null)
        if (run.status === 'done' && run.definition) {
          setAgentCandidate(run.definition)
          setAgentProgress(null)
          setNotice('Agent 已返回候选定义。请先应用或放弃，候选不会自动覆盖当前草稿。')
          setAgentRunId(null)
          return
        }
        if (['error', 'cancelled', 'interrupted'].includes(run.status)) {
          setError(run.error ?? (run.status === 'cancelled' ? 'Agent 运行已取消。' : 'Agent 运行未完成。'))
          setAgentRunId(null)
          return
        }
        timer = window.setTimeout(() => void poll(), 1_000)
      } catch (cause) {
        if (!controller.signal.aborted && active) {
          setError(cause instanceof Error ? cause.message : '节点设计 Agent 状态读取失败')
          timer = window.setTimeout(() => void poll(), 3_000)
        }
      }
    }
    void poll()
    return () => {
      active = false
      controller.abort()
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [agentRunId, api])

  const patchDraft = (patch: Partial<CustomNodeManifest>) => {
    setDraft((current) => ({ ...current, ...patch, updatedAt: new Date().toISOString() }))
    setNotice(null)
  }

  const createDraft = () => {
    if (studioLocked) return
    setDraft(createBlankCustomNodeManifest())
    setRequirement('')
    setPreviewState('content')
    setNotice(null)
    setError(null)
  }

  const generateDraft = () => {
    if (!requirement.trim()) return
    const generated = draftCustomNodeFromRequirement(requirement, draft)
    const existing = latestDefinitions.find((item) => item.id === generated.id)
    const next = {
      ...generated,
      revision: existing?.revision ?? 0,
      installed: false,
    }
    setDraft(next)
    setNotice('已根据需求生成声明式草稿，请检查预览和规范。')
    setError(null)
  }

  const startAgent = async () => {
    if (!requirement.trim() || studioLocked || agentStartingRef.current) return
    agentStartingRef.current = true
    setAgentStarting(true)
    setError(null)
    setNotice(null)
    setAgentProgress('正在准备节点规范与安全边界…')
    try {
      const runId = await api.startAgent(requirement.trim(), draft)
      setAgentRunId(runId)
    } catch (cause) {
      setAgentProgress(null)
      setError(cause instanceof Error ? cause.message : '节点设计 Agent 启动失败')
    } finally {
      agentStartingRef.current = false
      setAgentStarting(false)
    }
  }

  const cancelAgent = async () => {
    if (!agentRunId || agentCancelling) return
    setAgentCancelling(true)
    try {
      await api.cancelAgentRun(agentRunId)
      setAgentRunId(null)
      setAgentProgress(null)
      setNotice('Agent 运行已取消。')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Agent 运行取消失败')
    } finally {
      setAgentCancelling(false)
    }
  }

  const applyAgentCandidate = () => {
    if (!agentCandidate) return
    setDraft(agentCandidate)
    setAgentCandidate(null)
    setNotice('候选已应用到草稿；保存或安装前仍可继续调整。')
    setError(null)
  }

  const discardAgentCandidate = () => {
    setAgentCandidate(null)
    setNotice('Agent 候选已放弃，当前草稿未改变。')
  }

  const persist = async (install: boolean) => {
    const errors = validateCustomNodeManifest(draft)
    if (errors.length > 0) {
      setError(errors[0] ?? '节点定义未通过校验')
      return
    }
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setSaving(true)
    setError(null)
    try {
      const saved = await api.save({
        ...draft,
        installed: install,
        updatedAt: new Date().toISOString(),
      }, controller.signal)
      const nextDefinitions = [...definitions, saved]
      setDefinitions(nextDefinitions)
      setDraft(saved)
      if (install) registerCustomNodeTypes(nextDefinitions)
      setNotice(install
        ? `已安装 ${saved.label} ${customNodeRuntimeId(saved)}，可在画布创建菜单中使用。`
        : `草稿已保存为修订 ${saved.revision}。`)
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : '节点定义保存失败')
      }
    } finally {
      if (!controller.signal.aborted) setSaving(false)
    }
  }

  const removeDraft = async () => {
    if (installedRevision) {
      setError('已安装的节点需要保留历史版本，当前不能物理删除。')
      return
    }
    try {
      await api.delete(draft.id)
      const next = definitions.filter((item) => item.id !== draft.id)
      setDefinitions(next)
      setDraft(latestByPackage(next)[0] ?? createBlankCustomNodeManifest())
      setNotice('草稿已删除。')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '草稿删除失败')
    }
  }

  const exportManifest = () => {
    const blob = new Blob([`${JSON.stringify(draft, null, 2)}\n`], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${draft.id.replace(/[^a-z0-9-]+/giu, '-') || 'node-definition'}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex h-screen min-w-0 flex-col overflow-hidden bg-gg-bg font-sans text-gg-ink">
      <header className="flex h-14 shrink-0 items-center gap-3 overflow-x-auto border-b border-gg-line bg-white px-4">
        <Link to="/" aria-label="返回工作空间" className="flex h-8 w-8 items-center justify-center rounded-[9px] text-gg-muted hover:bg-gg-subtle hover:text-gg-ink">
          <ArrowLeft size={16} />
        </Link>
        <div className="flex h-8 w-8 items-center justify-center rounded-[9px] bg-[#EAF1FD] text-gg-primary">
          <Wrench size={16} />
        </div>
        <div className="min-w-0">
          <p className="text-[14px] font-semibold">节点创作工作台</p>
          <p className="text-[10.5px] text-gg-muted">节点规范的实时设计、预览与安装环境</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {installedRevision && (
            <span className="rounded-full bg-[#E7F6EF] px-2.5 py-1 text-[10.5px] font-medium text-gg-success">
              已安装 v{installedRevision.revision}
            </span>
          )}
          <button type="button" onClick={exportManifest} className="flex h-8 items-center gap-1.5 rounded-[9px] border border-gg-line bg-white px-3 text-[11.5px] text-gg-muted hover:text-gg-ink">
            <Download size={13} /> 导出定义
          </button>
          <button type="button" disabled={saving || studioLocked} onClick={() => void persist(false)} className="flex h-8 items-center gap-1.5 rounded-[9px] border border-gg-line bg-white px-3 text-[11.5px] hover:border-gg-select disabled:opacity-50">
            <Save size={13} /> 保存草稿
          </button>
          <button type="button" disabled={saving || studioLocked || validationErrors.length > 0} onClick={() => void persist(true)} className="flex h-8 items-center gap-1.5 rounded-[9px] bg-gg-primary px-3.5 text-[11.5px] font-medium text-white hover:bg-gg-select disabled:bg-gg-line disabled:text-gg-muted">
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
            安装到画布
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-x-auto">
        <aside className="flex w-[300px] shrink-0 flex-col border-r border-gg-line bg-white">
          <div className="border-b border-gg-line p-3">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-gg-muted">我的节点</p>
              <button type="button" disabled={studioLocked} onClick={createDraft} className="flex h-7 items-center gap-1 rounded-[8px] px-2 text-[11px] text-gg-primary hover:bg-gg-subtle disabled:opacity-45">
                <Plus size={12} /> 新建
              </button>
            </div>
            <div className="mt-2 max-h-[170px] space-y-1 overflow-auto">
              {loading ? (
                <p className="px-2 py-3 text-[11px] text-gg-muted">正在读取工作区节点…</p>
              ) : latestDefinitions.length === 0 ? (
                <p className="rounded-[10px] bg-gg-subtle px-3 py-3 text-[11px] leading-5 text-gg-muted">还没有自定义节点。描述需求即可开始。</p>
              ) : latestDefinitions.map((item) => {
                const ItemIcon = iconForKind(item.contentKind)
                return (
                  <button key={`${item.id}@${item.revision}`} type="button" disabled={studioLocked} aria-current={item.id === draft.id ? 'true' : undefined} onClick={() => setDraft(item)} className={`flex w-full items-center gap-2 rounded-[9px] px-2.5 py-2 text-left disabled:opacity-50 ${item.id === draft.id ? 'bg-[#EAF1FD]' : 'hover:bg-gg-subtle'}`}>
                    <ItemIcon size={14} className={item.id === draft.id ? 'text-gg-primary' : 'text-gg-muted'} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[11.5px] font-medium">{item.label}</span>
                      <span className="block truncate text-[9.5px] text-gg-muted">v{item.revision} · {item.installed ? '已安装' : '草稿'}</span>
                    </span>
                    <ChevronRight size={12} className="text-gg-muted" />
                  </button>
                )
              })}
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col p-4">
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-[8px] bg-[#EAF1FD] text-gg-primary"><Bot size={14} /></div>
              <div>
                <p className="text-[12px] font-semibold">需求共创</p>
                <p className="text-[10px] text-gg-muted">即时结构草拟 · 安全声明式输出</p>
              </div>
            </div>
            <div role="status" aria-live="polite" aria-atomic="true" className="mt-4 rounded-[12px] bg-gg-subtle p-3 text-[11px] leading-5 text-gg-muted">
              {agentBusy
                ? <><span className="font-medium text-gg-ink">Agent 正在设计节点</span><br />{agentProgress ?? (agentStarting ? '正在启动安全运行…' : '正在分析需求…')}</>
                : '告诉我节点要承载什么内容、有哪些操作、输出什么结果。Agent 只会返回受约束的候选定义，由你确认是否安装。'}
            </div>
            {agentCandidate && (
              <div className="mt-3 rounded-[12px] border border-blue-200 bg-blue-50 p-3">
                <p className="text-[11.5px] font-semibold text-gg-ink">候选：{agentCandidate.label}</p>
                <p className="mt-1 line-clamp-2 text-[10px] leading-4 text-gg-muted">{agentCandidate.description}</p>
                <div className="mt-2 flex justify-end gap-2">
                  <button type="button" onClick={discardAgentCandidate} className="h-7 rounded-[8px] px-2.5 text-[10.5px] text-gg-muted hover:bg-white">放弃候选</button>
                  <button type="button" onClick={applyAgentCandidate} className="h-7 rounded-[8px] bg-gg-primary px-2.5 text-[10.5px] font-medium text-white">应用候选</button>
                </div>
              </div>
            )}
            <label className="mt-3 flex min-h-[140px] flex-1 flex-col rounded-[12px] border border-gg-line bg-white p-3 focus-within:border-gg-primary">
              <span className="sr-only">描述节点需求</span>
              <textarea disabled={studioLocked} value={requirement} onChange={(event) => setRequirement(event.target.value)} placeholder="例如：做一个竞品分析节点，输入产品链接后生成对比表格，支持补充维度、提炼差异和生成总结。" className="min-h-[110px] flex-1 resize-none bg-transparent text-[12px] leading-5 outline-none placeholder:text-[#98A2B3] disabled:opacity-60" />
              <div className="mt-2 flex items-center justify-end gap-2">
                <button type="button" disabled={!requirement.trim() || studioLocked} onClick={generateDraft} className="flex h-8 items-center gap-1.5 rounded-[9px] border border-gg-line px-3 text-[11px] text-gg-muted hover:text-gg-ink disabled:opacity-50">
                  <Sparkles size={12} /> 快速起稿
                </button>
                {agentRunId ? (
                  <button type="button" disabled={agentCancelling} onClick={() => void cancelAgent()} className="flex h-8 items-center gap-1.5 rounded-[9px] border border-red-200 px-3 text-[11.5px] text-gg-danger hover:bg-red-50 disabled:opacity-50">
                    {agentCancelling && <Loader2 size={12} className="animate-spin" />} {agentCancelling ? '正在取消' : '取消 Agent'}
                  </button>
                ) : (
                  <button type="button" disabled={!requirement.trim() || studioLocked} onClick={() => void startAgent()} className="flex h-8 items-center gap-1.5 rounded-[9px] bg-gg-primary px-3 text-[11.5px] font-medium text-white disabled:bg-gg-line disabled:text-gg-muted">
                    <Bot size={13} /> 让 Agent 设计
                  </button>
                )}
              </div>
            </label>
            <p className="mt-2 text-[9.5px] leading-4 text-gg-muted">Agent 输出会先作为候选 JSON；不会执行生成代码，也不会绕过你的安装确认。</p>
          </div>
        </aside>

        <main className="flex min-w-[460px] flex-1 flex-col bg-[#F7F9FC]">
          <div className="flex h-12 shrink-0 items-center justify-between border-b border-gg-line bg-white px-5">
            <div>
              <p className="text-[12.5px] font-semibold">节点在画布中的生命周期</p>
              <p className="text-[10px] text-gg-muted">真实节点外壳 · 平台状态 · 分层披露</p>
            </div>
            <div role="tablist" aria-label="预览状态" className="flex rounded-[9px] bg-gg-subtle p-0.5">
              {([['empty', '空节点'], ['running', '生成中'], ['content', '已完成'], ['error', '失败']] as const).map(([state, label]) => (
                <button key={state} type="button" role="tab" aria-selected={previewState === state} onClick={() => setPreviewState(state)} className={`rounded-[7px] px-3 py-1.5 text-[10.5px] ${previewState === state ? 'bg-white font-medium text-gg-ink shadow-sm' : 'text-gg-muted'}`}>{label}</button>
              ))}
            </div>
          </div>
          <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center gap-6 overflow-auto p-8" style={{ backgroundImage: 'radial-gradient(#D8E2F0 1px, transparent 1px)', backgroundSize: '24px 24px' }}>
            <NodeStudioStateContract state={previewState} />
            <NodeStudioPreview manifest={draft} state={previewState} />
          </div>
          {(notice || error) && (
            <div role={error ? 'alert' : 'status'} className={`mx-5 mb-4 flex items-center gap-2 rounded-[10px] border px-3 py-2 text-[11px] ${error ? 'border-red-200 bg-red-50 text-gg-danger' : 'border-blue-200 bg-blue-50 text-gg-primary'}`}>
              {error ? <CircleAlert size={13} /> : <Check size={13} />}
              {error ?? notice}
            </div>
          )}
        </main>

        <aside className="w-[340px] shrink-0 overflow-y-auto border-l border-gg-line bg-white p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[12.5px] font-semibold">节点规范</p>
              <p className="text-[10px] text-gg-muted">声明式定义</p>
            </div>
            <button type="button" disabled={studioLocked} aria-label="新建空白节点草稿" onClick={createDraft} className="flex h-7 w-7 items-center justify-center rounded-[8px] text-gg-muted hover:bg-gg-subtle disabled:opacity-45"><RotateCcw size={13} /></button>
          </div>

          <fieldset disabled={studioLocked}>
          <Section title="基本信息">
            <Field label="节点名称"><input value={draft.label} onChange={(event) => patchDraft({ label: event.target.value })} /></Field>
            <Field label="节点 ID"><input value={draft.id} disabled={draft.revision > 0} onChange={(event) => patchDraft({ id: event.target.value })} className="font-mono" /></Field>
            <Field label="一句话说明"><textarea value={draft.description} onChange={(event) => patchDraft({ description: event.target.value })} rows={2} /></Field>
          </Section>

          <Section title="内容类型">
            <div className="grid grid-cols-4 gap-1.5">
              {KIND_OPTIONS.map(({ id, label, icon: KindIcon }) => (
                <button key={id} type="button" onClick={() => patchDraft({ contentKind: id, icon: id })} className={`flex flex-col items-center gap-1 rounded-[9px] border px-2 py-2 text-[10px] ${draft.contentKind === id ? 'border-gg-primary bg-[#EAF1FD] text-gg-primary' : 'border-gg-line text-gg-muted hover:border-gg-select'}`}>
                  <KindIcon size={14} /> {label}
                </button>
              ))}
            </div>
            <Field label={`默认宽度 · ${draft.defaultWidth}px`}><input type="range" min="280" max="640" step="20" value={draft.defaultWidth} onChange={(event) => patchDraft({ defaultWidth: Number(event.target.value) })} /></Field>
          </Section>

          <Section title="内容示例">
            <Field label="示例内容"><textarea value={draft.sampleContent} onChange={(event) => patchDraft({ sampleContent: event.target.value })} rows={4} /></Field>
          </Section>

          <Section title="组合与端口">
            <label className="flex items-center gap-2 text-[10.5px] text-gg-muted">
              <input type="checkbox" checked={draft.containment.canHaveChildren} onChange={(event) => patchDraft({ containment: event.target.checked ? { ...draft.containment, canHaveChildren: true, maxDepth: Math.max(1, draft.containment.maxDepth) } : { canHaveChildren: false, allowedChildTypes: [], maxDepth: 0 } })} />
              允许包含子节点
            </label>
            {draft.containment.canHaveChildren && <>
              <Field label={`最大深度 · ${draft.containment.maxDepth}`}><input type="range" min="1" max="32" value={draft.containment.maxDepth} onChange={(event) => patchDraft({ containment: { ...draft.containment, maxDepth: Number(event.target.value) } })} /></Field>
              <Field label="允许的 child type（每行一个）"><textarea value={draft.containment.allowedChildTypes.join('\n')} onChange={(event) => patchDraft({ containment: { ...draft.containment, allowedChildTypes: lines(event.target.value, 128) } })} rows={3} /></Field>
            </>}
            <Field label="端口：方向 key schema cardinality materialization"><textarea value={renderPorts(draft.ports)} onChange={(event) => patchDraft({ ports: parsePorts(event.target.value) })} rows={5} className="font-mono" /></Field>
          </Section>

          <Section title="执行与导出">
            <Field label="执行 capability"><input value={draft.execution?.capability ?? ''} onChange={(event) => patchDraft({ execution: executionField(draft.execution, 'capability', event.target.value) })} placeholder="留空表示不可执行" className="font-mono" /></Field>
            <Field label="执行 policy"><input value={draft.execution?.policy ?? ''} onChange={(event) => patchDraft({ execution: executionField(draft.execution, 'policy', event.target.value) })} placeholder="例如 sandboxed" className="font-mono" /></Field>
            <Field label="Exporter capability（每行一个）"><textarea value={draft.exporters.join('\n')} onChange={(event) => patchDraft({ exporters: lines(event.target.value, 64) })} rows={3} className="font-mono" /></Field>
            <label className="flex items-center gap-2 text-[10.5px] text-gg-muted">
              <input type="checkbox" checked={draft.agent.constructible} onChange={(event) => patchDraft({ agent: event.target.checked ? { constructible: true, writableInitSchema: draft.agent.writableInitSchema ?? draft.initialPayloadSchema } : { constructible: false } })} />
              Agent 可以在 GraphProposal 中创建
            </label>
            {draft.agent.constructible && <Field label="Agent writable init schema"><input value={draft.agent.writableInitSchema ?? ''} onChange={(event) => patchDraft({ agent: { constructible: true, writableInitSchema: event.target.value } })} className="font-mono" /></Field>}
          </Section>

          <Section title="提示词与操作">
            <Field label="输入占位"><textarea value={draft.placeholder} onChange={(event) => patchDraft({ placeholder: event.target.value })} rows={2} /></Field>
            <Field label="快捷指令（每行一个）"><textarea value={draft.actions.join('\n')} onChange={(event) => patchDraft({ actions: event.target.value.split('\n').map((item) => item.trim()).filter(Boolean).slice(0, 6) })} rows={4} /></Field>
          </Section>

          <Section title="自检">
            {validationErrors.length === 0 ? (
              <div className="flex items-center gap-2 rounded-[10px] bg-[#E7F6EF] px-3 py-2.5 text-[11px] text-gg-success"><Check size={13} /> 定义通过基础安全校验</div>
            ) : validationErrors.map((item) => (
              <div key={item} className="mb-1 flex items-start gap-2 rounded-[9px] bg-red-50 px-2.5 py-2 text-[10.5px] text-gg-danger"><CircleAlert size={12} className="mt-0.5 shrink-0" /> {item}</div>
            ))}
          </Section>

          <Section title="平台边界">
            <ul className="space-y-2 text-[10.5px] leading-4 text-gg-muted">
              <li className="flex items-start gap-2"><Check size={12} className="mt-0.5 shrink-0 text-gg-success" />节点定义只控制内容模板与快捷指令。</li>
              <li className="flex items-start gap-2"><Check size={12} className="mt-0.5 shrink-0 text-gg-success" />生成、权限和重试始终由所属 Task 控制。</li>
              <li className="flex items-start gap-2"><Check size={12} className="mt-0.5 shrink-0 text-gg-success" />过程、日志和能力配置进入平台侧栏。</li>
            </ul>
          </Section>

          <button type="button" onClick={() => void removeDraft()} className="mt-4 flex h-8 w-full items-center justify-center gap-1.5 rounded-[9px] text-[10.5px] text-gg-muted hover:bg-red-50 hover:text-gg-danger">
            <Trash2 size={12} /> 删除未安装草稿
          </button>
          </fieldset>
        </aside>
      </div>
    </div>
  )
}

function lines(value: string, limit: number): string[] {
  return [...new Set(value.split('\n').map((item) => item.trim()).filter(Boolean))].slice(0, limit)
}

function renderPorts(ports: readonly PortDefinition[]): string {
  return ports.map((port) => [
    port.direction,
    port.key,
    port.schema,
    port.cardinality,
    port.materialization ?? '',
  ].filter(Boolean).join(' ')).join('\n')
}

function parsePorts(value: string): PortDefinition[] {
  return lines(value, 128).flatMap((line) => {
    const [direction, key, schema, cardinality, materialization] = line.split(/\s+/u)
    if ((direction !== 'input' && direction !== 'output')
      || !key || !schema
      || (cardinality !== 'one' && cardinality !== 'many')
      || (materialization !== undefined
        && !['inline', 'tray', 'child-node', 'canvas-node'].includes(materialization))) return []
    return [{
      direction,
      key,
      schema,
      cardinality,
      ...(materialization
        ? { materialization: materialization as PortDefinition['materialization'] }
        : {}),
    }]
  })
}

function executionField(
  current: CustomNodeManifest['execution'],
  key: 'capability' | 'policy',
  value: string,
): CustomNodeManifest['execution'] {
  const next = {
    capability: current?.capability ?? '',
    policy: current?.policy ?? '',
    [key]: value.trim(),
  }
  return next.capability || next.policy ? next : undefined
}

function NodeStudioPreview({ manifest, state }: { manifest: CustomNodeManifest; state: PreviewState }) {
  const plugin = useMemo(() => createCustomNodeType(manifest), [manifest])
  const previewNode = useMemo<CanvasNode>(() => ({
    id: 'node-studio-preview',
    type: plugin.id,
    frame: { x: 0, y: 0, w: manifest.defaultWidth, h: 300, z: 0 },
    title: manifest.sampleTitle,
    ...(state === 'content' ? { text: manifest.sampleContent } : {}),
    payload: {},
    artifactRefs: [],
    origin: state === 'running' || state === 'error' || state === 'content'
      ? {
          kind: 'agent-output',
          taskId: 'node-studio-preview-task',
          runId: 'node-studio-preview-run',
          planId: 'node-studio-preview-plan',
          outputKey: 'preview',
        }
      : { kind: 'user' },
  }), [manifest.defaultWidth, manifest.sampleContent, manifest.sampleTitle, plugin.id, state])
  const taskStatus = useMemo<CanvasTaskStatus | undefined>(() => {
    if (state === 'running') {
      return { kind: 'generating', label: '生成中', live: 'off' }
    }
    if (state === 'error') {
      return { kind: 'failed', label: '运行失败', live: 'off' }
    }
    if (state === 'content') {
      return { kind: 'done', label: '已完成', progress: 1, live: 'off' }
    }
    return undefined
  }, [state])

  return (
    <div
      data-testid="node-studio-platform-preview"
      className="relative"
      style={{ width: Math.min(manifest.defaultWidth, 500), height: 300 }}
    >
      <CanvasNodeCard
        node={previewNode}
        pluginOverride={plugin}
        projectDir=""
        selected={state === 'content'}
        compact={false}
        taskStatus={taskStatus}
        taskRunId={state === 'running' || state === 'error' || state === 'content'
          ? 'node-studio-preview-run'
          : undefined}
        controlsLocked={state !== 'content'}
        tabIndex={0}
        onFocus={() => undefined}
        onKeyDown={() => undefined}
        onDragStart={() => undefined}
        onResizeStart={() => undefined}
        onMenuAction={() => undefined}
        registerFocusable={() => undefined}
      />
    </div>
  )
}

function NodeStudioStateContract({ state }: { state: PreviewState }) {
  const contract = {
    empty: {
      owner: 'Task',
      node: '安静空白内容面',
      disclosure: '提示词与生成入口在节点外',
    },
    running: {
      owner: 'Task',
      node: '平台生成动画 + 单行活动摘要',
      disclosure: '节点操作锁定',
    },
    content: {
      owner: '节点',
      node: '真实内容 + 轻量完成摘要',
      disclosure: '选中后显示上下文操作',
    },
    error: {
      owner: 'Task',
      node: '空白内容面 + 失败摘要',
      disclosure: '回到原 Task 调整并重试',
    },
  }[state]

  return (
    <div
      aria-label="当前节点状态契约"
      className="grid w-full max-w-[620px] grid-cols-3 gap-px overflow-hidden rounded-[12px] border border-gg-line bg-gg-line shadow-sm"
    >
      <StateFact label="控制归属" value={contract.owner} />
      <StateFact label="节点只表达" value={contract.node} />
      <StateFact label="下一层披露" value={contract.disclosure} />
    </div>
  )
}

function StateFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white px-3 py-2.5">
      <p className="text-[9.5px] text-gg-muted">{label}</p>
      <p className="mt-1 text-[10.5px] font-medium leading-4 text-gg-ink">{value}</p>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="mt-5 border-t border-gg-line pt-4"><h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.06em] text-gg-muted">{title}</h2><div className="space-y-3">{children}</div></section>
}

function Field({ label, children }: { label: string; children: ReactElement<{ className?: string }> }) {
  return <label className="block"><span className="mb-1 block text-[10.5px] text-gg-muted">{label}</span>{cloneElement(children, { className: `w-full rounded-[9px] border border-gg-line bg-white px-2.5 py-2 text-[11.5px] outline-none focus:border-gg-primary disabled:bg-gg-subtle disabled:text-gg-muted ${children.props.className ?? ''}` })}</label>
}

function iconForKind(kind: CustomNodeContentKind) {
  return KIND_OPTIONS.find((item) => item.id === kind)?.icon ?? LayoutTemplate
}

function latestByPackage(definitions: CustomNodeManifest[]): CustomNodeManifest[] {
  const latest = new Map<string, CustomNodeManifest>()
  definitions.forEach((item) => {
    if ((latest.get(item.id)?.revision ?? -1) < item.revision) latest.set(item.id, item)
  })
  return [...latest.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}
