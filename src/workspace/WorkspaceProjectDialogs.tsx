import {
  useRef,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import { Loader2, X } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import type { WorkspaceProject } from './projectClient'

export function DeleteProjectDialog({
  open,
  project,
  confirmation,
  error,
  deleting,
  onOpenChange,
  onConfirmationChange,
  onConfirm,
}: {
  open: boolean
  project: WorkspaceProject | null
  confirmation: string
  error: string | null
  deleting: boolean
  onOpenChange: (open: boolean) => void
  onConfirmationChange: (value: string) => void
  onConfirm: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const matchesProjectTitle = project !== null && confirmation === project.title
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        className="border-gg-line bg-gg-node text-gg-ink sm:max-w-[460px]"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          inputRef.current?.focus()
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
        }}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (matchesProjectTitle && !deleting) onConfirm()
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle className="text-[16px] text-gg-ink">
              删除项目“{project?.title ?? ''}”？
            </AlertDialogTitle>
            <AlertDialogDescription className="text-[12px] leading-5 text-gg-muted">
              该项目的画布、任务、运行记录和产物将被永久删除，此操作无法撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>

          <label
            htmlFor="delete-project-confirmation"
            className="mt-5 block text-[12px] font-medium text-gg-ink"
          >
            输入完整项目名“{project?.title ?? ''}”以确认
          </label>
          <input
            ref={inputRef}
            id="delete-project-confirmation"
            autoComplete="off"
            spellCheck={false}
            value={confirmation}
            disabled={deleting}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? 'delete-project-error' : undefined}
            onChange={(event) => onConfirmationChange(event.target.value)}
            className="mt-2 h-10 w-full rounded-[10px] border border-gg-line bg-white px-3 text-[13px] text-gg-ink outline-none transition-colors focus:border-red-500 disabled:bg-gg-subtle"
          />
          {error && (
            <p id="delete-project-error" role="alert" className="mt-2 text-[11.5px] text-red-600">
              {error}
            </p>
          )}

          <AlertDialogFooter className="mt-5">
            <AlertDialogCancel
              type="button"
              disabled={deleting}
              className="h-9 rounded-[10px] border-gg-line bg-white px-4 text-[13px] text-gg-ink hover:bg-gg-subtle"
            >
              取消
            </AlertDialogCancel>
            <button
              type="submit"
              disabled={deleting || !matchesProjectTitle}
              className="flex h-9 items-center justify-center gap-1.5 rounded-[10px] bg-red-600 px-4 text-[13px] font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {deleting && <Loader2 size={14} className="animate-spin" />}
              {deleting ? '正在删除' : '永久删除'}
            </button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export function CreateProjectDialog({
  title,
  error,
  creating,
  onTitleChange,
  onCancel,
  onSubmit,
}: {
  title: string
  error: string | null
  creating: boolean
  onTitleChange: (title: string) => void
  onCancel: () => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}) {
  const dialogRef = useRef<HTMLFormElement>(null)
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <form
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-project-title"
        aria-describedby="create-project-detail"
        onSubmit={onSubmit}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel()
          if (event.key === 'Tab') keepFocusInside(event, dialogRef.current)
        }}
        className="w-full max-w-[420px] rounded-[16px] border border-gg-line bg-gg-node p-5 shadow-float"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="create-project-title" className="text-[15px] font-semibold text-gg-ink">新建项目</h2>
            <p id="create-project-detail" className="mt-1 text-[12px] leading-5 text-gg-muted">
              项目会拥有独立的画布、任务和产物。
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={creating}
            aria-label="关闭新建项目窗口"
            className="flex h-7 w-7 items-center justify-center rounded-[8px] text-gg-muted hover:bg-gg-subtle hover:text-gg-ink disabled:opacity-50"
          >
            <X size={15} />
          </button>
        </div>

        <label htmlFor="workspace-project-title" className="mt-5 block text-[12px] font-medium text-gg-ink">
          项目名称
        </label>
        <input
          id="workspace-project-title"
          autoFocus
          required
          maxLength={120}
          value={title}
          onChange={(event) => onTitleChange(event.target.value)}
          disabled={creating}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? 'create-project-error' : undefined}
          placeholder="例如：实验结果分析"
          className="mt-2 h-10 w-full rounded-[10px] border border-gg-line bg-white px-3 text-[13px] text-gg-ink outline-none transition-colors placeholder:text-[#98A2B3] focus:border-gg-primary disabled:bg-gg-subtle"
        />
        {error && (
          <p id="create-project-error" role="alert" className="mt-2 text-[11.5px] text-red-600">
            {error}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={creating}
            className="h-9 rounded-[10px] border border-gg-line bg-white px-4 text-[13px] text-gg-ink hover:bg-gg-subtle disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={creating || !title.trim()}
            className="flex h-9 items-center gap-1.5 rounded-[10px] bg-gg-primary px-4 text-[13px] font-medium text-white hover:bg-gg-select disabled:cursor-not-allowed disabled:opacity-50"
          >
            {creating && <Loader2 size={14} className="animate-spin" />}
            {creating ? '正在创建' : '创建并打开'}
          </button>
        </div>
      </form>
    </div>
  )
}

function keepFocusInside(
  event: KeyboardEvent<HTMLElement>,
  dialog: HTMLElement | null,
) {
  if (!dialog) return
  const focusable = [...dialog.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
  )].filter((element) => !element.hasAttribute('hidden'))
  if (focusable.length === 0) {
    event.preventDefault()
    return
  }
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (event.shiftKey && globalThis.document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && globalThis.document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}
