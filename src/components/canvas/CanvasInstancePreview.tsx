import { Loader2, Unlink } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { DAEMON_URL } from '@/agent/config'
import type { CanvasNode } from '@/canvas/model'
import { useCanvasStore } from '@/canvas/hooks'
import { InstanceClient } from '@/instances/client'

export default function CanvasInstancePreview({
  node,
  projectDir,
  branch,
}: {
  node: CanvasNode
  projectDir: string
  branch: string
}) {
  const store = useCanvasStore()
  const client = useMemo(() => new InstanceClient(DAEMON_URL), [])
  const [nodes, setNodes] = useState<CanvasNode[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void client.resolved({ projectDir, branch, nodeId: node.id }).then(
      (resolved) => {
        if (!active) return
        setNodes(resolved.nodes)
        setError(null)
      },
      (reason: unknown) => {
        if (!active) return
        setError(reason instanceof Error ? reason.message : '实例解析失败')
      },
    )
    return () => { active = false }
  }, [branch, client, node.id, projectDir])
  const detach = async () => {
    setBusy(true)
    try {
      await store.dispatchCommand({ type: 'DetachInstance', nodeId: node.id })
      await store.flushCommands()
      setError(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '实例分离失败')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section data-instance-preview className="mt-2 border-t border-gg-line pt-2 text-[9.5px]">
      <div className="flex items-center justify-between gap-2 text-gg-muted">
        <span>
          {node.instanceRef?.definitionId} · rev {node.instanceRef?.revision}
          {nodes ? ` · ${nodes.length} 个解析节点` : ''}
        </span>
        <button type="button" disabled={busy} onClick={() => void detach()} className="flex h-6 items-center gap-1 rounded-[7px] bg-gg-subtle px-2 text-gg-primary disabled:opacity-50">
          {busy ? <Loader2 size={10} className="animate-spin" /> : <Unlink size={10} />}
          分离实例
        </button>
      </div>
      {nodes && (
        <div className="mt-1.5 grid grid-cols-2 gap-1">
          {nodes.slice(0, 8).map((resolved) => (
            <span key={resolved.id} className="truncate rounded-[6px] bg-gg-subtle px-1.5 py-1 text-gg-ink">
              {resolved.title} · {resolved.typeRef.id}
            </span>
          ))}
        </div>
      )}
      {!nodes && !error && <Loader2 size={11} className="mt-2 animate-spin text-gg-muted" aria-label="正在解析实例" />}
      {error && <span role="alert" className="mt-1 block text-red-700">{error}</span>}
    </section>
  )
}
