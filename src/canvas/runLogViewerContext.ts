import { createContext, useContext } from 'react'

export type CanvasRunLogViewerTab = 'process' | 'log'

/** Run 详情面板的打开请求：runId 指向一次 Task Run（持久日志按此读取）。 */
export interface CanvasRunLogViewerRequest {
  runId: string
  title: string
  /** 节点内的入口决定抽屉首先呈现友好过程还是原始日志。 */
  initialTab: CanvasRunLogViewerTab
}

export type OpenCanvasRunLogViewer = (request: CanvasRunLogViewerRequest) => void

export const CanvasRunLogViewerContext = createContext<OpenCanvasRunLogViewer | null>(null)

/** 节点活动条通过它请求打开 Run 详情面板；无 Provider 时不展示入口。 */
export function useOpenCanvasRunLogViewer(): OpenCanvasRunLogViewer | null {
  return useContext(CanvasRunLogViewerContext)
}
