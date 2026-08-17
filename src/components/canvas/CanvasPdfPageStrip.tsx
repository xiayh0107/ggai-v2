import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { DAEMON_URL, runArtifactUrl } from '@/agent/config'
import { PdfImportClient } from '@/pdf/client'
import type { PdfPageBaseline } from '@/pdf/contracts'

export default function CanvasPdfPageStrip({
  importId,
  pageCount,
  projectDir,
}: {
  importId: string
  pageCount: number
  projectDir: string
}) {
  const client = useMemo(() => new PdfImportClient(DAEMON_URL), [])
  const [pageNumber, setPageNumber] = useState(1)
  const [page, setPage] = useState<PdfPageBaseline | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void client.page({ projectDir, importId, pageNumber }).then(
      (value) => {
        if (!active) return
        setPage(value)
        setError(null)
        setLoading(false)
      },
      (reason: unknown) => {
        if (!active) return
        setError(reason instanceof Error ? reason.message : '页面预览失败')
        setLoading(false)
      },
    )
    return () => { active = false }
  }, [client, importId, pageNumber, projectDir])
  const navigate = (nextPage: number) => {
    setLoading(true)
    setPage(null)
    setError(null)
    setPageNumber(nextPage)
  }
  return (
    <section data-pdf-page-strip className="mt-2 border-t border-gg-line pt-2">
      <div className="flex items-center justify-between text-[9.5px] text-gg-muted">
        <button type="button" aria-label="上一页" disabled={pageNumber <= 1 || loading} onClick={() => navigate(Math.max(1, pageNumber - 1))} className="rounded-[6px] p-1 hover:bg-gg-subtle disabled:opacity-30"><ChevronLeft size={11} /></button>
        <span>{pageNumber} / {pageCount} 页</span>
        <button type="button" aria-label="下一页" disabled={pageNumber >= pageCount || loading} onClick={() => navigate(Math.min(pageCount, pageNumber + 1))} className="rounded-[6px] p-1 hover:bg-gg-subtle disabled:opacity-30"><ChevronRight size={11} /></button>
      </div>
      <div className="mt-1.5 flex min-h-20 items-center justify-center overflow-hidden rounded-[8px] bg-gg-subtle">
        {loading && <Loader2 size={14} className="animate-spin text-gg-muted" aria-label="正在生成页面预览" />}
        {!loading && page && (
          <img
            src={runArtifactUrl(page.preview.runId, page.preview.artifactId, projectDir)}
            alt={`PDF 第 ${page.pageNumber} 页预览`}
            className="max-h-40 max-w-full object-contain"
          />
        )}
        {error && <span role="alert" className="p-2 text-[9.5px] text-red-700">{error}</span>}
      </div>
      {page?.text.summary && <p className="mt-1 line-clamp-2 text-[9px] text-gg-muted">{page.text.summary}</p>}
    </section>
  )
}
