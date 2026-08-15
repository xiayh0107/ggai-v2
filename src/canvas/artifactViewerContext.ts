import { createContext, useContext } from 'react'
import type { TrustedArtifactProjection } from '@/plugins/types'

/** 查看面板的内容形态：由调用方（插件内联视图）按产物类型给出。 */
export type CanvasArtifactViewerKind = 'text' | 'code' | 'image' | 'file'

export interface CanvasArtifactViewerRequest {
  artifact: TrustedArtifactProjection
  kind: CanvasArtifactViewerKind
  title: string
  /** 产物来源节点：用于在查看面板提供节点类型专属工具条与正文样式。 */
  nodeId?: string
}

export type OpenCanvasArtifactViewer = (request: CanvasArtifactViewerRequest) => void

/**
 * 按产物媒体类型推断查看面板形态：图片大图、代码暗色等宽、纯文本 Markdown、
 * 其余类型给出外链。供拿不到插件内联视图语义的入口（如多产物链接条）使用。
 */
export function artifactViewerKindForMediaType(mediaType: string): CanvasArtifactViewerKind {
  if (mediaType.startsWith('image/')) return 'image'
  if (mediaType.startsWith('text/')) {
    return /^text\/(plain|markdown|csv|tab-separated-values)\b/u.test(mediaType) ? 'text' : 'code'
  }
  if (/^application\/([\w.+-]*\+?(json|xml)|javascript|x-javascript|typescript|x-yaml|yaml|toml|sql|x-sh)\b/u
    .test(mediaType)) {
    return 'code'
  }
  return 'file'
}

export const CanvasArtifactViewerContext = createContext<OpenCanvasArtifactViewer | null>(null)

/** 节点内联视图通过它请求打开产物查看面板；无 Provider 时退回新标签页打开。 */
export function useOpenCanvasArtifactViewer(): OpenCanvasArtifactViewer | null {
  return useContext(CanvasArtifactViewerContext)
}
