import { describe, expect, it } from 'vitest'
import {
  WorkspaceProjectProtocolError,
  WorkspaceProjectRequestError,
} from './projectClient'
import { workspaceProjectErrorMessage } from './projectMessages'

describe('workspaceProjectErrorMessage', () => {
  it('maps known request errors without exposing daemon details', () => {
    const error = new WorkspaceProjectRequestError(
      'Workspace project project_secret is unavailable at /private/path',
      409,
      'project_unavailable',
    )

    const message = workspaceProjectErrorMessage(error, 'fallback')
    expect(message).toBe('项目当前不可用，请检查本地项目状态后重试。')
    expect(message).not.toContain('project_secret')
    expect(message).not.toContain('/private/path')
  })

  it('uses stable language for protocol drift and unknown failures', () => {
    expect(workspaceProjectErrorMessage(
      new WorkspaceProjectProtocolError('unexpected internal field'),
      'fallback',
    )).toContain('无法识别的数据')
    expect(workspaceProjectErrorMessage(new Error('private detail'), '安全文案'))
      .toBe('安全文案')
  })

  it('maps busy deletion failures to actionable language', () => {
    expect(workspaceProjectErrorMessage(
      new WorkspaceProjectRequestError('private daemon state', 409, 'project_busy'),
      '删除失败',
    )).toBe('项目正在运行或处理中，请结束相关任务后重试。')
  })
})
