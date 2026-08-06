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
})
