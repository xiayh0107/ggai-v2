import { Play, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { DAEMON_URL } from '@/agent/config'
import type { CanvasNode } from '@/canvas/model'
import { NodeExecutionClient } from '@/execution/client'
import type { NodeExecution } from '@/execution/contracts'

export default function CanvasNodeExecutionTray({
  node,
  projectDir,
  branch,
  executable,
  onSelect,
}: {
  node: CanvasNode
  projectDir: string
  branch: string
  executable: boolean
  onSelect?: (executionId: string | null) => void
}) {
  const client = useMemo(() => new NodeExecutionClient(DAEMON_URL), [])
  const [history, setHistory] = useState<NodeExecution[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setHistory(await client.list({ projectDir, branch, nodeId: node.id }))
      setError(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '执行历史读取失败')
    }
  }, [branch, client, node.id, projectDir])
  useEffect(() => {
    void refresh()
  }, [refresh])

  const run = async () => {
    setBusy(true)
    try {
      await client.start({ projectDir, branch, nodeId: node.id })
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '节点执行失败')
    } finally {
      setBusy(false)
    }
  }
  const latest = history[0]
  return (
    <div data-node-execution-tray className="mt-2 flex items-center gap-2 border-t border-gg-line pt-2 text-[9.5px] text-gg-muted">
      {executable && (
        <button type="button" disabled={busy} onClick={() => void run()} className="flex h-6 items-center gap-1 rounded-[7px] bg-gg-subtle px-2 text-gg-primary disabled:opacity-50">
          <Play size={10} /> {busy ? '启动中' : '运行'}
        </button>
      )}
      <button type="button" aria-label="刷新执行历史" onClick={() => void refresh()} className="flex h-6 w-6 items-center justify-center rounded-[7px] hover:bg-gg-subtle"><RefreshCw size={10} /></button>
      {latest ? (
        <button type="button" onClick={() => onSelect?.(latest.executionId)} className="truncate hover:text-gg-primary">
          {latest.status} · {Object.values(latest.outputs).reduce((count, values) => count + values.length, 0)} outputs
        </button>
      ) : <span>暂无执行</span>}
      {node.selectedExecutionId && <button type="button" onClick={() => onSelect?.(null)} className="ml-auto text-gg-primary">跟随最新</button>}
      {error && <span role="alert" className="truncate text-red-700">{error}</span>}
    </div>
  )
}
