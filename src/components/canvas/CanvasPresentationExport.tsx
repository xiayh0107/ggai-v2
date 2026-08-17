import { Download, Loader2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { DAEMON_URL, runArtifactUrl } from '@/agent/config'
import { PresentationExportClient } from '@/presentation/client'
import type { PresentationExportMode, PresentationExportResponse } from '@/presentation/contracts'

export default function CanvasPresentationExport({
  nodeId,
  projectDir,
  branch,
  defaultMode,
}: {
  nodeId: string
  projectDir: string
  branch: string
  defaultMode: PresentationExportMode
}) {
  const client = useMemo(() => new PresentationExportClient(DAEMON_URL), [])
  const [mode, setMode] = useState(defaultMode)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<PresentationExportResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const run = async () => {
    setBusy(true)
    try {
      setResult(await client.export({
        projectDir, branch, presentationNodeId: nodeId, mode,
      }))
      setError(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'PPTX 导出失败')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div data-presentation-export className="mt-2 flex items-center gap-2 border-t border-gg-line pt-2 text-[9.5px]">
      <select value={mode} disabled={busy} onChange={(event) => setMode(event.target.value as PresentationExportMode)} aria-label="PPTX 导出模式" className="h-6 rounded-[7px] border border-gg-line bg-gg-node px-1 text-gg-muted">
        <option value="hybrid">混合</option>
        <option value="editable">可编辑</option>
        <option value="fidelity">高保真</option>
      </select>
      <button type="button" disabled={busy} onClick={() => void run()} className="flex h-6 items-center gap-1 rounded-[7px] bg-gg-primary px-2 text-white disabled:opacity-50">
        {busy ? <Loader2 size={10} className="animate-spin" /> : <Download size={10} />}
        {busy ? '导出中' : '导出 PPTX'}
      </button>
      {result && (
        <a href={runArtifactUrl(result.pptx.runId, result.pptx.artifactId, projectDir)} className="text-gg-primary underline" download>
          下载 · {result.diagnosticCount} 条诊断
        </a>
      )}
      {error && <span role="alert" className="truncate text-red-700">{error}</span>}
    </div>
  )
}
