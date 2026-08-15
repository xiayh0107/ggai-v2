import { friendlyToolLabel } from '@/agent/generationProgress'
import type { CanvasTaskRunLogEntry } from '@/canvas/runController'

const MAX_VISIBLE_ACTIVITIES = 8

export interface ActivityItem {
  key: string
  label: string
  warning?: boolean
}

/** 把原始运行日志折叠成面向用户的步骤序列（去重相邻同类、限量）。 */
export function activitiesFromRunLog(
  logs: readonly CanvasTaskRunLogEntry[],
): ActivityItem[] {
  const items: ActivityItem[] = []
  const push = (key: string, label: string, warning = false) => {
    const last = items.at(-1)
    if (last && last.key === key) {
      last.label = label
      last.warning = warning
      return
    }
    items.push({ key: `${key}:${items.length}`, label, warning })
  }
  for (const entry of logs) {
    if (entry.kind === 'thinking') {
      push('thinking', '理解任务与上下文')
    } else if (entry.kind === 'text') {
      push('writing', '生成内容')
    } else if (entry.kind === 'tool' && entry.text.startsWith('→ ')) {
      const body = entry.text.slice(2)
      const spaceIndex = body.indexOf(' ')
      const name = spaceIndex === -1 ? body : body.slice(0, spaceIndex)
      push(`tool:${name.toLowerCase()}`, friendlyToolLabel(name))
    } else if (entry.kind === 'warning') {
      push(`warning:${items.length}`, entry.text.slice(0, 80), true)
    }
    // '←' 工具结果不单独成条，避免噪音。
  }
  return items.slice(-MAX_VISIBLE_ACTIVITIES)
}
