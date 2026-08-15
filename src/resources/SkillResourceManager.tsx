import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { Link } from 'react-router'
import {
  ArrowLeft,
  Archive,
  BookOpen,
  Boxes,
  Check,
  ChevronDown,
  FileText,
  FolderInput,
  Loader2,
  Plus,
  RefreshCw,
  Search,
} from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  getPluginRegistryVersion,
  listPlugins,
  subscribePlugins,
} from '@/plugins/types'
import {
  isSkillId,
  type NodeTypeSkillBindings,
  type SkillAssetRef,
  type SkillAssetSummary,
} from '@/skills/contracts'
import {
  SkillAssetRequestError,
  type SkillAssetApi,
  type SkillAssetCatalogPayload,
} from '@/skills/client'

type CatalogState =
  | { status: 'loading'; catalog: SkillAssetCatalogPayload | null }
  | { status: 'ready'; catalog: SkillAssetCatalogPayload }
  | { status: 'error'; catalog: SkillAssetCatalogPayload | null; message: string }

interface ImportDraft {
  skillId: string
  sourcePath: string
}

const EMPTY_IMPORT: ImportDraft = { skillId: '', sourcePath: '' }

export default function SkillResourceManager({ api }: { api: SkillAssetApi }) {
  const pluginRegistryVersion = useSyncExternalStore(
    subscribePlugins,
    getPluginRegistryVersion,
    getPluginRegistryVersion,
  )
  const [state, setState] = useState<CatalogState>({ status: 'loading', catalog: null })
  const [reloadToken, setReloadToken] = useState(0)
  const [query, setQuery] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [importDraft, setImportDraft] = useState<ImportDraft>(EMPTY_IMPORT)
  const [mutation, setMutation] = useState<'import' | 'archive' | 'binding' | null>(null)
  const [mutationError, setMutationError] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const [archiveTarget, setArchiveTarget] = useState<SkillAssetSummary | null>(null)
  const [selectedNodeType, setSelectedNodeType] = useState('')
  const [selectedSkills, setSelectedSkills] = useState<SkillAssetRef[]>([])
  const mutationController = useRef<AbortController | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setState((current) => ({ status: 'loading', catalog: current.catalog }))
    void api.list(controller.signal).then(
      (catalog) => {
        if (!controller.signal.aborted) setState({ status: 'ready', catalog })
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        setState((current) => ({
          status: 'error',
          catalog: current.catalog,
          message: skillErrorMessage(error),
        }))
      },
    )
    return () => controller.abort()
  }, [api, reloadToken])

  useEffect(() => () => mutationController.current?.abort(), [])

  const catalog = state.catalog
  const groups = useMemo(() => groupSkillAssets(catalog?.assets ?? []), [catalog?.assets])
  const visibleGroups = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    if (!normalized) return groups
    return groups.filter((group) => [group.skillId, group.latest.title, group.latest.description]
      .some((value) => value.toLocaleLowerCase().includes(normalized)))
  }, [groups, query])
  const nodeTypes = useMemo(() => {
    void pluginRegistryVersion
    const plugins = listPlugins().map((plugin) => ({ id: plugin.id, label: plugin.label }))
    const known = new Set(plugins.map((plugin) => plugin.id))
    const unavailable = (catalog?.typeBindings ?? [])
      .filter((binding) => !known.has(binding.nodeType))
      .map((binding) => ({ id: binding.nodeType, label: `${binding.nodeType}（未安装）` }))
    return [...plugins, ...unavailable].sort((left, right) =>
      left.label.localeCompare(right.label, 'zh-CN'))
  }, [catalog?.typeBindings, pluginRegistryVersion])

  useEffect(() => {
    if (selectedNodeType && nodeTypes.some((nodeType) => nodeType.id === selectedNodeType)) return
    setSelectedNodeType(nodeTypes[0]?.id ?? '')
  }, [nodeTypes, selectedNodeType])

  const currentBinding = catalog?.typeBindings.find((binding) =>
    binding.nodeType === selectedNodeType)

  useEffect(() => {
    setSelectedSkills(currentBinding?.skills ?? [])
    setMutationError(null)
  }, [currentBinding, selectedNodeType])

  const importRevision = latestRevision(catalog?.assets ?? [], importDraft.skillId) + 1
  const canImport = isSkillId(importDraft.skillId)
    && importDraft.sourcePath.startsWith('/')
    && mutation === null
  const bindingChanged = !sameSkillRefs(currentBinding?.skills ?? [], selectedSkills)
  const activeAssetCount = groups.filter((group) => !group.latest.archived).length

  const beginMutation = (kind: NonNullable<typeof mutation>) => {
    mutationController.current?.abort()
    const controller = new AbortController()
    mutationController.current = controller
    setMutation(kind)
    setMutationError(null)
    setAnnouncement('')
    return controller
  }

  const finishMutation = () => {
    mutationController.current = null
    setMutation(null)
  }

  const importSkill = async () => {
    if (!canImport) return
    const controller = beginMutation('import')
    try {
      const imported = await api.import({
        sourcePath: importDraft.sourcePath.trim(),
        skillId: importDraft.skillId.trim(),
        expectedRevision: importRevision - 1,
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      setState((current) => current.catalog
        ? { status: 'ready', catalog: upsertAsset(current.catalog, imported) }
        : current)
      setImportOpen(false)
      setImportDraft(EMPTY_IMPORT)
      setAnnouncement(`已安装 ${imported.title} 的第 ${imported.revision} 个修订`)
    } catch (error) {
      if (!controller.signal.aborted) setMutationError(skillErrorMessage(error))
    } finally {
      if (!controller.signal.aborted) finishMutation()
    }
  }

  const archiveSkill = async () => {
    if (!archiveTarget || mutation !== null) return
    const target = archiveTarget
    const controller = beginMutation('archive')
    try {
      await api.archive(target.skillId, controller.signal)
      if (controller.signal.aborted) return
      setState((current) => current.catalog
        ? { status: 'ready', catalog: archiveAsset(current.catalog, target.skillId) }
        : current)
      setArchiveTarget(null)
      setAnnouncement(`已归档 ${target.title}；现有绑定和历史运行保持不变`)
    } catch (error) {
      if (!controller.signal.aborted) setMutationError(skillErrorMessage(error))
    } finally {
      if (!controller.signal.aborted) finishMutation()
    }
  }

  const saveTypeBinding = async () => {
    if (!selectedNodeType || !bindingChanged || mutation !== null) return
    const controller = beginMutation('binding')
    try {
      const binding = await api.updateTypeBindings({
        nodeType: selectedNodeType,
        expectedRevision: currentBinding?.revision ?? 0,
        skills: selectedSkills,
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      setState((current) => current.catalog
        ? { status: 'ready', catalog: upsertBinding(current.catalog, binding) }
        : current)
      setAnnouncement(`已更新“${nodeTypes.find((entry) => entry.id === selectedNodeType)?.label ?? selectedNodeType}”的默认 Skills`)
    } catch (error) {
      if (!controller.signal.aborted) setMutationError(skillErrorMessage(error))
    } finally {
      if (!controller.signal.aborted) finishMutation()
    }
  }

  return (
    <div className="min-h-screen bg-gg-bg text-gg-ink">
      <header className="sticky top-0 z-20 flex h-[58px] items-center gap-3 border-b border-gg-line bg-white px-5">
        <Link
          to="/resources"
          aria-label="返回资源库"
          className="flex h-8 w-8 items-center justify-center rounded-[8px] text-gg-muted outline-none hover:bg-gg-subtle hover:text-gg-ink focus-visible:ring-2 focus-visible:ring-gg-primary/35"
        >
          <ArrowLeft size={17} aria-hidden="true" />
        </Link>
        <div className="min-w-0 flex-1">
          <p className="text-[10.5px] text-gg-muted">资源库 / 节点能力</p>
          <h1 className="truncate text-[14px] font-semibold">任务 Skills</h1>
        </div>
        <button
          type="button"
          onClick={() => {
            setMutationError(null)
            setImportDraft(EMPTY_IMPORT)
            setImportOpen(true)
          }}
          className="inline-flex h-9 items-center gap-1.5 rounded-[9px] bg-gg-primary px-3 text-[11.5px] font-medium text-white outline-none hover:bg-gg-primary/90 focus-visible:ring-2 focus-visible:ring-gg-primary/35"
        >
          <Plus size={14} aria-hidden="true" /> 安装 Skill
        </button>
      </header>

      <main className="mx-auto w-full max-w-[1180px] px-6 py-7">
        <section className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-[20px] font-semibold">节点的专属任务能力</h2>
            <p className="mt-1 max-w-[720px] text-[12px] leading-5 text-gg-muted">
              将明确指定的 Skill 目录纳入工作空间资产库，并设置节点类型的默认能力。每次安装都会保存为不可变修订，运行时按绑定版本固定。
            </p>
          </div>
          <div className="flex gap-2 text-[10.5px] text-gg-muted">
            <span className="rounded-full border border-gg-line bg-white px-2.5 py-1">{activeAssetCount} 个可用 Skill</span>
            <span className="rounded-full border border-gg-line bg-white px-2.5 py-1">{catalog?.typeBindings.length ?? 0} 类节点已绑定</span>
          </div>
        </section>

        {state.status === 'error' && (
          <div role="alert" className="mt-5 flex items-center justify-between gap-4 rounded-[12px] border border-red-200 bg-white px-4 py-3 text-[11.5px] text-red-700">
            <span>{state.message}</span>
            <button
              type="button"
              onClick={() => setReloadToken((value) => value + 1)}
              className="inline-flex shrink-0 items-center gap-1 text-gg-primary"
            >
              <RefreshCw size={13} aria-hidden="true" /> 重试
            </button>
          </div>
        )}
        {mutationError && (
          <p role="alert" className="mt-5 rounded-[12px] border border-red-200 bg-white px-4 py-3 text-[11.5px] text-red-700">
            {mutationError}
          </p>
        )}
        <p role="status" aria-live="polite" className="sr-only">{announcement}</p>

        <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(320px,0.8fr)]">
          <section className="rounded-[16px] border border-gg-line bg-white p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-[14px] font-semibold">Skill 资产</h3>
                <p className="mt-0.5 text-[11px] text-gg-muted">安装会移动原目录；此后由工作空间资产库统一管理，Agent 使用固定修订。</p>
              </div>
              <label className="flex h-9 min-w-[220px] items-center gap-2 rounded-[9px] border border-gg-line px-3 text-gg-muted focus-within:border-gg-primary">
                <Search size={14} aria-hidden="true" />
                <span className="sr-only">搜索 Skills</span>
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索名称或标识"
                  className="min-w-0 flex-1 bg-transparent text-[11.5px] text-gg-ink outline-none placeholder:text-gg-muted"
                />
              </label>
            </div>

            {state.status === 'loading' && !catalog && (
              <p role="status" className="flex min-h-40 items-center justify-center gap-2 text-[11.5px] text-gg-muted">
                <Loader2 size={14} className="animate-spin" aria-hidden="true" /> 正在读取 Skills…
              </p>
            )}
            {catalog && groups.length === 0 && (
              <div className="mt-5 flex min-h-48 flex-col items-center justify-center rounded-[12px] border border-dashed border-gg-line text-center">
                <BookOpen size={24} className="text-gg-muted" aria-hidden="true" />
                <p className="mt-3 text-[12px] font-medium">还没有安装 Skill</p>
                <p className="mt-1 max-w-[360px] text-[11px] leading-5 text-gg-muted">选择一个包含根级 SKILL.md 的目录，建立第一个可绑定能力。</p>
              </div>
            )}
            {catalog && groups.length > 0 && visibleGroups.length === 0 && (
              <p className="mt-5 rounded-[12px] bg-gg-subtle px-4 py-8 text-center text-[11.5px] text-gg-muted">没有匹配的 Skill。</p>
            )}
            {visibleGroups.length > 0 && (
              <ul className="mt-4 space-y-2" aria-label="Skill 资产列表">
                {visibleGroups.map((group) => (
                  <li key={group.skillId} className="rounded-[12px] border border-gg-line p-4">
                    <div className="flex items-start gap-3">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] bg-gg-subtle text-gg-primary">
                        <FileText size={16} aria-hidden="true" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h4 className="truncate text-[12.5px] font-medium">{group.latest.title}</h4>
                          {group.latest.archived && (
                            <span className="rounded-full border border-gg-line px-2 py-0.5 text-[9.5px] text-gg-muted">已归档</span>
                          )}
                        </div>
                        <p className="mt-0.5 truncate font-mono text-[10px] text-gg-muted">{group.skillId}</p>
                        {group.latest.description && <p className="mt-2 text-[11px] leading-5 text-gg-muted">{group.latest.description}</p>}
                        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-gg-muted">
                          <span>修订 {group.latest.revision}</span>
                          <span>{group.latest.fileCount} 个文件</span>
                          <span>{formatBytes(group.latest.totalBytes)}</span>
                          <span>{bindingCount(catalog?.typeBindings ?? [], group.skillId)} 类节点使用</span>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {!group.latest.archived && (
                          <button
                            type="button"
                            aria-label={`安装 ${group.latest.title} 的新修订`}
                            onClick={() => {
                              setMutationError(null)
                              setImportDraft({ skillId: group.skillId, sourcePath: '' })
                              setImportOpen(true)
                            }}
                            className="flex h-8 items-center gap-1 rounded-[8px] px-2 text-[10.5px] text-gg-primary outline-none hover:bg-gg-subtle focus-visible:ring-2 focus-visible:ring-gg-primary/35"
                          >
                            <FolderInput size={13} aria-hidden="true" /> 新修订
                          </button>
                        )}
                        {!group.latest.archived && (
                          <button
                            type="button"
                            aria-label={`归档 ${group.latest.title}`}
                            onClick={() => {
                              setMutationError(null)
                              setArchiveTarget(group.latest)
                            }}
                            className="flex h-8 w-8 items-center justify-center rounded-[8px] text-gg-muted outline-none hover:bg-red-50 hover:text-red-700 focus-visible:ring-2 focus-visible:ring-red-300"
                          >
                            <Archive size={13} aria-hidden="true" />
                          </button>
                        )}
                      </div>
                    </div>
                    {group.revisions.length > 1 && (
                      <details className="mt-3 border-t border-gg-line pt-2">
                        <summary className="flex cursor-pointer list-none items-center gap-1 text-[10.5px] text-gg-muted">
                          <ChevronDown size={12} aria-hidden="true" /> {group.revisions.length} 个不可变修订
                        </summary>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {group.revisions.map((asset) => (
                            <span key={`${asset.skillId}:${asset.revision}`} className="rounded-full bg-gg-subtle px-2 py-1 font-mono text-[9.5px] text-gg-muted">
                              r{asset.revision} · {asset.digest.slice(0, 8)}
                            </span>
                          ))}
                        </div>
                      </details>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="self-start rounded-[16px] border border-gg-line bg-white p-5 lg:sticky lg:top-[78px]">
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] bg-gg-subtle text-gg-primary">
                <Boxes size={16} aria-hidden="true" />
              </span>
              <div>
                <h3 className="text-[14px] font-semibold">节点类型默认绑定</h3>
                <p className="mt-1 text-[11px] leading-5 text-gg-muted">新建或现有节点默认继承这里的能力；节点自己的专属覆盖保存在画布版本中。</p>
              </div>
            </div>

            {nodeTypes.length === 0 ? (
              <p className="mt-5 rounded-[10px] bg-gg-subtle px-3 py-5 text-center text-[11px] text-gg-muted">还没有可绑定的节点类型。</p>
            ) : (
              <>
                <label className="mt-5 block text-[10.5px] font-medium text-gg-muted">
                  节点类型
                  <select
                    value={selectedNodeType}
                    onChange={(event) => setSelectedNodeType(event.target.value)}
                    className="mt-1.5 h-10 w-full rounded-[9px] border border-gg-line bg-white px-3 text-[11.5px] text-gg-ink outline-none focus:border-gg-primary focus:ring-2 focus:ring-gg-primary/15"
                  >
                    {nodeTypes.map((nodeType) => <option key={nodeType.id} value={nodeType.id}>{nodeType.label}</option>)}
                  </select>
                </label>

                <fieldset className="mt-5">
                  <legend className="text-[10.5px] font-medium text-gg-muted">默认 Skills</legend>
                  {groups.filter((group) => !group.latest.archived
                    || selectedSkills.some((skill) => skill.skillId === group.skillId)).length === 0 ? (
                      <p className="mt-2 rounded-[10px] bg-gg-subtle px-3 py-5 text-center text-[11px] text-gg-muted">先安装 Skill，再为节点类型设置默认能力。</p>
                    ) : (
                      <div className="mt-2 space-y-1.5">
                        {groups
                          .filter((group) => !group.latest.archived
                            || selectedSkills.some((skill) => skill.skillId === group.skillId))
                          .map((group) => {
                            const selected = selectedSkills.find((skill) => skill.skillId === group.skillId)
                            const ref = group.latest.archived && selected
                              ? selected
                              : toRef(group.latest)
                            return (
                              <label key={group.skillId} className="flex cursor-pointer items-center gap-2.5 rounded-[9px] border border-gg-line px-3 py-2.5 hover:border-gg-primary/50">
                                <input
                                  type="checkbox"
                                  checked={Boolean(selected)}
                                  onChange={(event) => setSelectedSkills((current) =>
                                    selectSkillRef(current, ref, event.target.checked))}
                                  className="h-4 w-4 accent-gg-primary"
                                />
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-[11px] font-medium">{group.latest.title}</span>
                                  <span className="block truncate font-mono text-[9.5px] text-gg-muted">{group.skillId} · r{ref.revision}</span>
                                </span>
                                {selected && <Check size={13} className="text-gg-primary" aria-hidden="true" />}
                              </label>
                            )
                          })}
                      </div>
                    )}
                </fieldset>

                <div className="mt-5 flex items-center justify-between gap-3 border-t border-gg-line pt-4">
                  <span className="text-[10px] text-gg-muted">绑定修订 {currentBinding?.revision ?? 0}</span>
                  <button
                    type="button"
                    onClick={() => void saveTypeBinding()}
                    disabled={!bindingChanged || mutation !== null}
                    className="inline-flex h-9 items-center gap-1.5 rounded-[9px] bg-gg-primary px-3 text-[11px] font-medium text-white outline-none hover:bg-gg-primary/90 focus-visible:ring-2 focus-visible:ring-gg-primary/35 disabled:cursor-not-allowed disabled:bg-gg-line disabled:text-gg-muted"
                  >
                    {mutation === 'binding' && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
                    保存默认绑定
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      </main>

      <Dialog open={importOpen} onOpenChange={(open) => {
        if (mutation === 'import') return
        setImportOpen(open)
        if (!open) {
          setImportDraft(EMPTY_IMPORT)
          setMutationError(null)
        }
      }}>
        <DialogContent className="max-w-[520px] rounded-[16px] border-gg-line bg-white">
          <DialogHeader>
            <DialogTitle>移动并安装 Skill</DialogTitle>
            <DialogDescription>选择包含根级 SKILL.md 的绝对目录。安装成功后，原目录会移动到工作空间资产库并成为唯一事实源。</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <label className="block text-[11px] font-medium text-gg-ink">
              Skill 标识
              <input
                autoFocus
                value={importDraft.skillId}
                onChange={(event) => setImportDraft((current) => ({ ...current, skillId: event.target.value }))}
                placeholder="@workspace/image-direction"
                className="mt-1.5 h-10 w-full rounded-[9px] border border-gg-line px-3 font-mono text-[11px] outline-none focus:border-gg-primary focus:ring-2 focus:ring-gg-primary/15"
              />
            </label>
            <label className="block text-[11px] font-medium text-gg-ink">
              来源目录
              <input
                value={importDraft.sourcePath}
                onChange={(event) => setImportDraft((current) => ({ ...current, sourcePath: event.target.value }))}
                placeholder="/Users/you/skills/image-direction"
                className="mt-1.5 h-10 w-full rounded-[9px] border border-gg-line px-3 font-mono text-[11px] outline-none focus:border-gg-primary focus:ring-2 focus:ring-gg-primary/15"
              />
            </label>
            <div className="rounded-[10px] bg-gg-subtle px-3 py-2.5 text-[10.5px] leading-5 text-gg-muted">
              {isSkillId(importDraft.skillId)
                ? `将创建修订 ${importRevision}。原目录会被移动；已有节点绑定不会自动切换到新修订。`
                : '标识可使用命名空间，例如 @workspace/my-skill。'}
            </div>
            {mutationError && <p role="alert" className="text-[11px] text-red-700">{mutationError}</p>}
          </div>
          <DialogFooter>
            <button type="button" onClick={() => setImportOpen(false)} disabled={mutation === 'import'} className="h-9 rounded-[9px] border border-gg-line px-3 text-[11px] text-gg-ink disabled:opacity-50">取消</button>
            <button type="button" onClick={() => void importSkill()} disabled={!canImport} className="inline-flex h-9 items-center gap-1.5 rounded-[9px] bg-gg-primary px-3 text-[11px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-40">
              {mutation === 'import' && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
              移动并安装
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={archiveTarget !== null} onOpenChange={(open) => {
        if (!open && mutation !== 'archive') setArchiveTarget(null)
      }}>
        <AlertDialogContent className="rounded-[16px] border-gg-line bg-white">
          <AlertDialogHeader>
            <AlertDialogTitle>归档“{archiveTarget?.title}”？</AlertDialogTitle>
            <AlertDialogDescription>它会从可用 Skill 列表中隐藏。不可变修订、现有节点绑定和历史运行不会被删除。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={mutation === 'archive'}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault()
                void archiveSkill()
              }}
              disabled={mutation !== null}
              className="bg-red-600 text-white hover:bg-red-700"
            >
              {mutation === 'archive' && <Loader2 size={13} className="mr-1 animate-spin" aria-hidden="true" />}
              归档 Skill
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

interface SkillAssetGroup {
  skillId: string
  latest: SkillAssetSummary
  revisions: SkillAssetSummary[]
}

function groupSkillAssets(assets: readonly SkillAssetSummary[]): SkillAssetGroup[] {
  const grouped = new Map<string, SkillAssetSummary[]>()
  for (const asset of assets) {
    const revisions = grouped.get(asset.skillId) ?? []
    revisions.push(asset)
    grouped.set(asset.skillId, revisions)
  }
  return [...grouped.entries()].map(([skillId, revisions]) => {
    const ordered = [...revisions].sort((left, right) => right.revision - left.revision)
    return { skillId, latest: ordered[0] as SkillAssetSummary, revisions: ordered }
  }).sort((left, right) => left.latest.title.localeCompare(right.latest.title, 'zh-CN'))
}

function latestRevision(assets: readonly SkillAssetSummary[], skillId: string): number {
  return assets.reduce((latest, asset) => asset.skillId === skillId
    ? Math.max(latest, asset.revision)
    : latest, 0)
}

function toRef(asset: SkillAssetSummary): SkillAssetRef {
  return { skillId: asset.skillId, revision: asset.revision, digest: asset.digest }
}

function selectSkillRef(
  current: readonly SkillAssetRef[],
  ref: SkillAssetRef,
  selected: boolean,
): SkillAssetRef[] {
  const withoutSkill = current.filter((entry) => entry.skillId !== ref.skillId)
  return selected ? [...withoutSkill, ref].sort((left, right) => left.skillId.localeCompare(right.skillId)) : withoutSkill
}

function sameSkillRefs(left: readonly SkillAssetRef[], right: readonly SkillAssetRef[]): boolean {
  if (left.length !== right.length) return false
  const orderedLeft = [...left].sort(compareSkillRef)
  const orderedRight = [...right].sort(compareSkillRef)
  return orderedLeft.every((entry, index) => {
    const other = orderedRight[index]
    return other?.skillId === entry.skillId
      && other.revision === entry.revision
      && other.digest === entry.digest
  })
}

function compareSkillRef(left: SkillAssetRef, right: SkillAssetRef): number {
  return left.skillId.localeCompare(right.skillId)
    || left.revision - right.revision
    || left.digest.localeCompare(right.digest)
}

function bindingCount(bindings: readonly NodeTypeSkillBindings[], skillId: string): number {
  return bindings.filter((binding) => binding.skills.some((skill) => skill.skillId === skillId)).length
}

function upsertAsset(
  catalog: SkillAssetCatalogPayload,
  asset: SkillAssetSummary,
): SkillAssetCatalogPayload {
  return {
    ...catalog,
    assets: [...catalog.assets.filter((entry) =>
      entry.skillId !== asset.skillId || entry.revision !== asset.revision), asset],
  }
}

function archiveAsset(
  catalog: SkillAssetCatalogPayload,
  skillId: string,
): SkillAssetCatalogPayload {
  return {
    ...catalog,
    assets: catalog.assets.map((asset) => asset.skillId === skillId
      ? { ...asset, archived: true }
      : asset),
  }
}

function upsertBinding(
  catalog: SkillAssetCatalogPayload,
  binding: NodeTypeSkillBindings,
): SkillAssetCatalogPayload {
  return {
    ...catalog,
    typeBindings: [
      ...catalog.typeBindings.filter((entry) => entry.nodeType !== binding.nodeType),
      binding,
    ].sort((left, right) => left.nodeType.localeCompare(right.nodeType)),
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_048_576) return `${Math.round(bytes / 1_024)} KB`
  return `${(bytes / 1_048_576).toFixed(1)} MB`
}

function skillErrorMessage(error: unknown): string {
  if (error instanceof SkillAssetRequestError) {
    if (error.code === 'skill_asset_conflict') return '资源已在其他窗口更新，请刷新后重试。'
    if (error.code === 'invalid_skill_asset') return 'Skill 目录或内容不符合安装要求。'
    return error.message
  }
  return error instanceof Error ? error.message : 'Skill 资源暂时无法处理。'
}
