import { useEffect, useMemo, useState } from 'react'
import { ExternalLink, Loader2, RefreshCw, WandSparkles } from 'lucide-react'
import { Link } from 'react-router'
import type { CanvasNode } from '@/canvas/model'
import { getPlugin } from '@/plugins/types'
import type { SkillAssetApi, SkillAssetCatalogPayload } from '@/skills/client'
import {
  type NodeSkillBindings,
  type SkillAssetRef,
  type SkillAssetSummary,
} from '@/skills/contracts'

interface CanvasWorkbenchSkillsProps {
  api: SkillAssetApi
  selectedNode: CanvasNode | null
  onSave: (nodeId: string, bindings: NodeSkillBindings) => Promise<unknown>
}

export default function CanvasWorkbenchSkills({
  api,
  selectedNode,
  onSave,
}: CanvasWorkbenchSkillsProps) {
  const [catalog, setCatalog] = useState<SkillAssetCatalogPayload | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [message, setMessage] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [inheritType, setInheritType] = useState(selectedNode?.skillBindings?.inheritType ?? true)
  const [selectedSkills, setSelectedSkills] = useState<SkillAssetRef[]>(selectedNode?.skillBindings?.skills ?? [])
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setStatus('loading')
    setMessage('')
    void api.list(controller.signal).then(
      (payload) => {
        if (controller.signal.aborted) return
        setCatalog(payload)
        setStatus('ready')
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        setStatus('error')
        setMessage(error instanceof Error ? error.message : 'Skills 暂时无法读取')
      },
    )
    return () => controller.abort()
  }, [api, attempt])

  useEffect(() => {
    setInheritType(selectedNode?.skillBindings?.inheritType ?? true)
    setSelectedSkills(selectedNode?.skillBindings?.skills ?? [])
    setSaveError(null)
  }, [selectedNode?.id, selectedNode?.skillBindings])

  const assets = useMemo(
    () => latestSkillAssets(catalog?.assets ?? [], selectedSkills),
    [catalog?.assets, selectedSkills],
  )
  const typeBinding = catalog?.typeBindings.find((binding) =>
    binding.nodeType === selectedNode?.typeRef.id)
  const originalBindings: NodeSkillBindings = selectedNode?.skillBindings ?? {
    inheritType: true,
    skills: [],
  }
  const changed = selectedNode
    ? inheritType !== originalBindings.inheritType
      || !sameRefs(selectedSkills, originalBindings.skills)
    : false

  const toggleSkill = (asset: SkillAssetSummary) => {
    setSelectedSkills((current) => {
      const exists = current.some((ref) => ref.skillId === asset.skillId)
      if (exists) return current.filter((ref) => ref.skillId !== asset.skillId)
      return [...current.filter((ref) => ref.skillId !== asset.skillId), toRef(asset)]
        .sort((left, right) => left.skillId.localeCompare(right.skillId))
    })
  }

  const save = async () => {
    if (!selectedNode || !changed || saving) return
    setSaving(true)
    setSaveError(null)
    try {
      await onSave(selectedNode.id, { inheritType, skills: selectedSkills })
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : '节点 Skills 保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-medium text-gg-ink">工作空间 Skills</p>
          <p className="mt-0.5 text-[9.5px] text-gg-muted">固定修订会随节点进入 Agent 上下文</p>
        </div>
        <button
          type="button"
          onClick={() => setAttempt((value) => value + 1)}
          disabled={status === 'loading'}
          aria-label="刷新 Skills"
          className="flex h-8 w-8 items-center justify-center rounded-[8px] text-gg-muted outline-none hover:bg-gg-subtle hover:text-gg-ink disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-gg-primary/35"
        >
          <RefreshCw size={13} className={status === 'loading' ? 'animate-spin' : ''} aria-hidden="true" />
        </button>
      </div>

      {status === 'loading' && !catalog && (
        <p role="status" className="flex min-h-28 items-center justify-center gap-2 text-[10.5px] text-gg-muted">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" /> 正在读取 Skills…
        </p>
      )}
      {status === 'error' && (
        <div role="alert" className="rounded-[12px] border border-red-200 p-3 text-[10.5px] text-red-700">
          <p>{message}</p>
          <button type="button" onClick={() => setAttempt((value) => value + 1)} className="mt-2 text-gg-primary">
            重试
          </button>
        </div>
      )}

      {!selectedNode && catalog && (
        <>
          <div className="rounded-[12px] border border-dashed border-gg-line px-3 py-4 text-center">
            <WandSparkles size={20} className="mx-auto text-gg-muted" aria-hidden="true" />
            <p className="mt-2 text-[10.5px] font-medium text-gg-ink">选择节点以绑定专属 Skills</p>
            <p className="mt-1 text-[9.5px] leading-4 text-gg-muted">
              当前仍可浏览工作空间能力；实例绑定需要明确选中一个节点。
            </p>
          </div>
          <SkillAssetList assets={assets} selectedSkills={[]} onToggle={null} />
        </>
      )}

      {selectedNode && catalog && (
        <>
          <section className="rounded-[12px] border border-gg-line p-3">
            <p className="text-[9.5px] text-gg-muted">当前节点</p>
            <p className="mt-0.5 truncate text-[11.5px] font-medium text-gg-ink">{selectedNode.title}</p>
            <p className="mt-0.5 text-[9.5px] text-gg-muted">
              {getPlugin(selectedNode.typeRef.id).label} · 类型默认 {typeBinding?.skills.length ?? 0} 个
            </p>
            {typeBinding && typeBinding.skills.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {typeBinding.skills.map((skill) => (
                  <span key={skill.skillId} className="rounded-full bg-gg-subtle px-2 py-1 text-[9px] text-gg-muted">
                    {skill.skillId}
                  </span>
                ))}
              </div>
            )}
          </section>

          <label className="flex cursor-pointer items-start gap-2.5 rounded-[11px] border border-gg-line p-3">
            <input
              type="checkbox"
              checked={inheritType}
              onChange={(event) => setInheritType(event.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 accent-gg-primary"
            />
            <span>
              <span className="block text-[10.5px] font-medium text-gg-ink">继承节点类型的默认 Skills</span>
              <span className="mt-0.5 block text-[9.5px] leading-4 text-gg-muted">
                关闭后，下面选中的 Skills 将完全替换类型默认能力。
              </span>
            </span>
          </label>

          <SkillAssetList
            assets={assets}
            selectedSkills={selectedSkills}
            onToggle={toggleSkill}
          />
          {saveError && <p role="alert" className="text-[10.5px] text-red-700">{saveError}</p>}
          <button
            type="button"
            onClick={() => void save()}
            disabled={!changed || saving}
            className="h-9 w-full rounded-[9px] bg-gg-primary text-[10.5px] font-medium text-white outline-none disabled:cursor-not-allowed disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-gg-primary/35"
          >
            {saving ? '保存中…' : '保存节点 Skills'}
          </button>
        </>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Link
          to="/resources/skills"
          className="flex h-9 items-center justify-center gap-1 rounded-[9px] border border-gg-line text-[10px] text-gg-ink outline-none hover:border-gg-primary hover:text-gg-primary focus-visible:ring-2 focus-visible:ring-gg-primary/35"
        >
          管理 Skills <ExternalLink size={10} aria-hidden="true" />
        </Link>
        <Link
          to="/node-studio"
          className="flex h-9 items-center justify-center gap-1 rounded-[9px] border border-gg-line text-[10px] text-gg-ink outline-none hover:border-gg-primary hover:text-gg-primary focus-visible:ring-2 focus-visible:ring-gg-primary/35"
        >
          节点工作台 <ExternalLink size={10} aria-hidden="true" />
        </Link>
      </div>
    </div>
  )
}

function SkillAssetList({
  assets,
  selectedSkills,
  onToggle,
}: {
  assets: SkillAssetSummary[]
  selectedSkills: SkillAssetRef[]
  onToggle: ((asset: SkillAssetSummary) => void) | null
}) {
  if (assets.length === 0) {
    return (
      <p className="rounded-[12px] border border-dashed border-gg-line px-3 py-5 text-center text-[10px] text-gg-muted">
        还没有可用 Skill。请先进入资源库导入。
      </p>
    )
  }
  return (
    <div className="space-y-1" aria-label="可用 Skills">
      {assets.map((asset) => {
        const selected = selectedSkills.some((ref) => ref.skillId === asset.skillId)
        const body = (
          <>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[10.5px] font-medium text-gg-ink">{asset.title}</span>
              <span className="mt-0.5 block truncate text-[9px] text-gg-muted">
                {asset.skillId} · 修订 {asset.revision}{asset.archived ? ' · 已归档' : ''}
              </span>
            </span>
            {onToggle && (
              <input
                type="checkbox"
                checked={selected}
                onChange={() => onToggle(asset)}
                tabIndex={-1}
                aria-hidden="true"
                className="h-3.5 w-3.5 shrink-0 accent-gg-primary"
              />
            )}
          </>
        )
        return onToggle ? (
          <button
            key={`${asset.skillId}:${asset.revision}`}
            type="button"
            aria-pressed={selected}
            onClick={() => onToggle(asset)}
            className={`flex w-full items-center gap-2 rounded-[10px] border px-2.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-gg-primary/35 ${
              selected ? 'border-gg-primary bg-gg-subtle' : 'border-gg-line hover:bg-gg-subtle'
            }`}
          >
            {body}
          </button>
        ) : (
          <div key={`${asset.skillId}:${asset.revision}`} className="flex items-center gap-2 rounded-[10px] border border-gg-line px-2.5 py-2">
            {body}
          </div>
        )
      })}
    </div>
  )
}

function latestSkillAssets(
  assets: readonly SkillAssetSummary[],
  selected: readonly SkillAssetRef[],
): SkillAssetSummary[] {
  const byId = new Map<string, SkillAssetSummary>()
  for (const asset of assets) {
    const current = byId.get(asset.skillId)
    const isSelected = selected.some((ref) =>
      ref.skillId === asset.skillId && ref.revision === asset.revision && ref.digest === asset.digest)
    if (!current || isSelected || (!selected.some((ref) => ref.skillId === asset.skillId)
      && asset.revision > current.revision)) {
      byId.set(asset.skillId, asset)
    }
  }
  return [...byId.values()]
    .filter((asset) => !asset.archived || selected.some((ref) => ref.skillId === asset.skillId))
    .sort((left, right) => left.title.localeCompare(right.title, 'zh-CN'))
}

function toRef(asset: SkillAssetSummary): SkillAssetRef {
  return { skillId: asset.skillId, revision: asset.revision, digest: asset.digest }
}

function sameRefs(left: readonly SkillAssetRef[], right: readonly SkillAssetRef[]): boolean {
  if (left.length !== right.length) return false
  const otherById = new Map(right.map((ref) => [ref.skillId, ref]))
  return left.every((ref) => {
    const other = otherById.get(ref.skillId)
    return other?.revision === ref.revision && other.digest === ref.digest
  })
}
