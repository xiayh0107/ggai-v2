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
  get(planId: string): Promise<ProjectionPlanRecordV2 | undefined>
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
  /** Runs only after the reconstructed close is durable. */
  onProjectionPlanReady?(input: {
    plan: ProjectionPlanRecordV2['plan']
    projectDir: string
    canvasBranch: string
  }): Promise<void>
}

export interface InterruptedTaskRunRecoveryFailureV2 {
  runId: string
  stage: 'manifest' | 'projection-plan' | 'run-log' | 'projection-hook'
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
    try {
      // A terminal close is the authoritative settlement boundary. In
      // particular, a crash after close+materialization but before summary
      // rewrite must not downgrade the completed pending plan to partial.
      const existingClose = await options.runLogs.terminalClose(summary.runId)
      if (existingClose) {
        if (existingClose.projectionPlan && options.onProjectionPlanReady) {
          let record: ProjectionPlanRecordV2 | undefined
          try {
            record = await options
              .projectionPlanStore(summary.canvasBranch ?? 'main')
              .get(existingClose.projectionPlan.planId)
            if (!record) throw new TypeError('durable close projection plan is not registered')
            assertMatchingDurablePlan(record, existingClose)
          } catch (error) {
            record = undefined
            report.failures.push(failure(summary.runId, 'projection-plan', error))
          }
          if (record?.state === 'pending') {
            try {
              await options.onProjectionPlanReady({
                plan: record.plan,
                projectDir: options.projectDir,
                canvasBranch: summary.canvasBranch ?? 'main',
              })
            } catch (error) {
              report.failures.push(failure(summary.runId, 'projection-hook', error))
            }
          }
        }
        continue
      }
    } catch (error) {
      report.failures.push(failure(summary.runId, 'run-log', error))
      continue
    }
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
      const appended = await options.runLogs.appendInterruptedCloseIfMissing(summary.runId, close)
      if (appended) {
        report.appendedCloses += 1
        if (projection && options.onProjectionPlanReady) {
          try {
            await options.onProjectionPlanReady({
              plan: projection.plan,
              projectDir: options.projectDir,
              canvasBranch: summary.canvasBranch ?? 'main',
            })
          } catch (error) {
            report.failures.push(failure(summary.runId, 'projection-hook', error))
          }
        }
      }
    } catch (error) {
      report.failures.push(failure(summary.runId, 'run-log', error))
    }
  }

  return report
}

function assertMatchingDurablePlan(
  record: ProjectionPlanRecordV2,
  close: RunClosePayload,
): void {
  if (!close.projectionPlan
    || record.plan.digest !== close.projectionPlan.digest
    || JSON.stringify(record.plan) !== JSON.stringify(close.projectionPlan)
    || JSON.stringify(record.suggestedActions) !== JSON.stringify(close.suggestedActions ?? [])) {
    throw new TypeError('registered projection plan does not match its durable close')
  }
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
