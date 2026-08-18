import { AlertTriangle, Save } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { DAEMON_URL } from '@/agent/config'
import { FilesystemClient } from '@/filesystem/client'
import type { FilesystemBinding } from '@/filesystem/contracts'

export default function CanvasFilesystemBindingStatus({
  bindingId,
  projectDir,
  branch,
}: {
  bindingId: string
  projectDir: string
  branch: string
}) {
  const client = useMemo(() => new FilesystemClient(DAEMON_URL), [])
  const [binding, setBinding] = useState<FilesystemBinding | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const refresh = useCallback(async () => {
    try {
      setBinding(await client.binding(projectDir, bindingId))
      setMessage(null)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '文件绑定不可用')
    }
  }, [bindingId, client, projectDir])
  useEffect(() => { void refresh() }, [refresh])

  const save = async () => {
    setBusy(true)
    try {
      setBinding(await client.save(projectDir, branch, bindingId))
      setMessage(null)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }
  if (!binding && !message) return null
  const conflict = binding?.state === 'conflict'
  return (
    <div data-filesystem-binding className={`mt-2 flex items-center gap-2 border-t pt-2 text-[9.5px] ${
      conflict ? 'border-red-200 text-red-700' : 'border-gg-line text-gg-muted'
    }`}>
      {conflict && <AlertTriangle size={11} aria-hidden="true" />}
      <span className="truncate">
        {conflict ? '文件冲突：Canvas 与磁盘均已修改' : `文件同步 · ${binding?.state ?? '不可用'}`}
      </span>
      {binding && binding.mode !== 'fs-authoritative' && (
        <button type="button" disabled={busy || conflict} onClick={() => void save()} className="ml-auto flex h-6 items-center gap-1 rounded-[7px] bg-gg-subtle px-2 text-gg-primary disabled:opacity-50">
          <Save size={10} aria-hidden="true" /> 保存到磁盘
        </button>
      )}
      {message && <span role="alert" className="truncate">{message}</span>}
    </div>
  )
}
