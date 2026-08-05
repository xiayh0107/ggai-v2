import path from 'node:path'
import type { ArtifactManifestV1 } from './artifactManifestV2.js'
import { BUILTIN_PROJECTION_PLUGIN_CONTRACTS_V2 } from './projectionPluginsV2.js'
import type { ProjectionPlanRecordV2 } from './projectionPlanStoreV2.js'
import type { RunClosePayload, RunSummary } from './protocol.js'
import type { RunArtifactStoreV2 } from './runArtifactStorageV2.js'
import type { RunLogStore } from './runLogs.js'

export type InterruptedProjectionPlanDispositionV2 =
  | 'created'
  | 'replaced-pending'
  | 'closed'

/** Narrow structural contract implemented by the branch-local plan store. */
export interface InterruptedProjectionPlanStoreV2 {
  recoverInterrupted(input: {
    taskId: string
    runId: string
    manifest: ArtifactManifestV1
    plugins: typeof BUILTIN_PROJECTION_PLUGIN_CONTRACTS_V2
  }): Promise<{
    record: ProjectionPlanRecordV2
    disposition: InterruptedProjectionPlanDispositionV2
  }>
}

export interface RecoverInterruptedTaskRunsV2Options {
  projectDir: string
  runLogs: RunLogStore
  artifactStore(canvasBranch: string): RunArtifactStoreV2
  projectionPlanStore(canvasBranch: string): InterruptedProjectionPlanStoreV2
}

export interface InterruptedTaskRunRecoveryFailureV2 {
  runId: string
  stage: 'manifest' | 'projection-plan' | 'run-log'
  message: string
}

export interface InterruptedTaskRunRecoveryReportV2 {
  candidates: number
  appendedCloses: number
  closedPlans: number
  failures: InterruptedTaskRunRecoveryFailureV2[]
}

/**
 * Reconstructs daemon-owned settlement for Task V2 runs left active by a
 * process crash. Each run is isolated: damaged artifact/plan/log state is
 * reported but never prevents another durable summary from being recovered.
 */
export async function recoverInterruptedTaskRunsV2(
  options: RecoverInterruptedTaskRunsV2Options,
): Promise<InterruptedTaskRunRecoveryReportV2> {
  const candidates = await options.runLogs.prepareInterruptedRecovery()
  const report: InterruptedTaskRunRecoveryReportV2 = {
    candidates: candidates.length,
    appendedCloses: 0,
    closedPlans: 0,
    failures: [],
  }

  for (const { summary } of candidates) {
    const baseClose = interruptedClose(summary)
    let manifest: ArtifactManifestV1 | undefined
    let artifacts: string[] = []
    let projection: {
      plan: ProjectionPlanRecordV2['plan']
      suggestedActions: []
    } | undefined

    try {
      const artifactStore = options.artifactStore(summary.canvasBranch ?? 'main')
      const existing = await artifactStore.manifest(summary.runId)
      const closed = existing
        ? { location: artifactStore.location(summary.runId), manifest: existing }
        : await artifactStore.closeRun(summary.runId, { complete: false })
      manifest = closed.manifest
      artifacts = manifest.entries.map((entry) => path.posix.join(
        closed.location.projectRelativeFilesRoot,
        entry.relativePath,
      ))
    } catch (error) {
      report.failures.push(failure(summary.runId, 'manifest', error))
    }

    if (manifest) {
      try {
        const recovered = await options
          .projectionPlanStore(summary.canvasBranch ?? 'main')
          .recoverInterrupted({
            taskId: summary.taskId,
            runId: summary.runId,
            manifest,
            plugins: BUILTIN_PROJECTION_PLUGIN_CONTRACTS_V2,
          })
        if (recovered.disposition === 'closed') {
          report.closedPlans += 1
        } else {
          assertSafeInterruptedPlan(recovered.record, summary)
          projection = { plan: recovered.record.plan, suggestedActions: [] }
        }
      } catch (error) {
        report.failures.push(failure(summary.runId, 'projection-plan', error))
      }
    }

    const close: RunClosePayload & { status: 'interrupted' } = {
      ...baseClose,
      artifacts,
      ...(manifest ? { artifactManifest: manifest } : {}),
      ...(projection
        ? {
            projectionPlan: projection.plan,
            suggestedActions: projection.suggestedActions,
          }
        : {}),
    }
    try {
      if (await options.runLogs.appendInterruptedCloseIfMissing(summary.runId, close)) {
        report.appendedCloses += 1
      }
    } catch (error) {
      report.failures.push(failure(summary.runId, 'run-log', error))
    }
  }

  return report
}

function interruptedClose(
  summary: RunSummary & { taskId: string },
): RunClosePayload & { status: 'interrupted' } {
  return {
    runId: summary.runId,
    status: 'interrupted',
    sessionId: summary.sessionId,
    artifacts: [],
    artifactsComplete: false,
  }
}

function assertSafeInterruptedPlan(
  record: ProjectionPlanRecordV2,
  summary: RunSummary & { taskId: string },
): void {
  if (record.state !== 'pending'
    || record.plan.runId !== summary.runId
    || record.plan.taskId !== summary.taskId
    || record.plan.status !== 'partial'
    || record.plan.taskProposals.length > 0
    || record.suggestedActions.length > 0) {
    throw new TypeError('recovered projection plan did not satisfy interrupted-run constraints')
  }
}

function failure(
  runId: string,
  stage: InterruptedTaskRunRecoveryFailureV2['stage'],
  error: unknown,
): InterruptedTaskRunRecoveryFailureV2 {
  return {
    runId,
    stage,
    message: error instanceof Error ? error.message : String(error),
  }
}
