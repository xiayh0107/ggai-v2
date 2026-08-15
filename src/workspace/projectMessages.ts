import {
  WorkspaceProjectProtocolError,
  WorkspaceProjectRequestError,
} from './projectClient'

/** Maps daemon/protocol failures to stable product language without exposing internals. */
export function workspaceProjectErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof WorkspaceProjectRequestError) {
    switch (error.code) {
      case 'invalid_project_title':
        return '项目名称不符合要求，请修改后重试。'
      case 'project_title_conflict':
        return '已经有同名项目，请换一个名称。'
      case 'project_not_found':
        return '项目不存在或已经被移除。'
      case 'project_unavailable':
        return '项目当前不可用，请检查本地项目状态后重试。'
      case 'project_busy':
        return '项目正在运行或处理中，请结束相关任务后重试。'
      case 'daemon_instance_active':
        return '项目已在另一个本地服务中打开，请先关闭那个进程。'
      case 'daemon_lease_stale':
        return '项目上次异常退出，需要先完成本地恢复。'
      case 'project_catalog_corrupt':
      case 'unsafe_workspace_catalog':
        return '本地项目列表需要修复，请检查服务状态后重试。'
      default:
        return error.status >= 500
          ? '本地项目服务暂时不可用，请稍后重试。'
          : fallback
    }
  }
  if (error instanceof WorkspaceProjectProtocolError) {
    return '项目服务返回了无法识别的数据，请重启本地服务后重试。'
  }
  return fallback
}
