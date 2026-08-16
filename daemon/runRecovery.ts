import path from 'node:path'
import type { ArtifactManifest } from './artifactManifest.js'
import {
  BUILTIN_PROJECTION_PLUGIN_CAPABILITY_SNAPSHOT,
  projectionPluginContracts,
  type RecoverableProjectionPluginCapabilitySnapshot,
} from './pluginCapabilities.js'
import type { ProjectionPluginContract } from './projectionPlan.js'
import type { ProjectionPlanRecord } from './projectionPlanStore.js'
import type { RunClosePayload, RunSummary } from './protocol.js'
import type { RunArtifactStore } from './runArtifactStorage.js'
import type { RunLogStore } from './runLogs.js'

export type InterruptedProjectionPlanDisposition =
  | 'created'
  | 'replaced-pending'
  | 'closed'

/** Narrow structural contract implemented by the branch-local plan store. */
export interface InterruptedProjectionPlanStore {
  get(planId: string): Promise<ProjectionPlanRecord | undefined>
  dismiss(planId: string): Promise<ProjectionPlanRecord>
  recoverInterrupted(input: {
    taskId: string
    runId: string
    manifest: ArtifactManifest
    plugins: readonly ProjectionPluginContract[]
  }): Promise<{
    record: ProjectionPlanRecord
    disposition: InterruptedProjectionPlanDisposition
  }>
}

export interface RecoverInterruptedTaskRunsOptions {
  projectDir: string
  runLogs: RunLogStore
  artifactStore(canvasBranch: string): RunArtifactStore
  projectionPlanStore(canvasBranch: string): InterruptedProjectionPlanStore
  /** Resolves the registry digest persisted in summary.json. */
  pluginCapabilities?(
    digest: string | undefined,
  ): Promise<RecoverableProjectionPluginCapabilitySnapshot>
  /** Verifies the immutable receipt fixed in the summary before settlement recovery. */
  capabilityReceipt?(runId: string, digest: string | undefined): Promise<void>
  /** Runs only after the reconstructed close is durable. */
  onProjectionPlanReady?(input: {
    plan: ProjectionPlanRecord['plan']
    projectDir: string
    canvasBranch: string
  }): Promise<void>
}

export interface InterruptedTaskRunRecoveryFailure {
  runId: string
  stage:
    | 'manifest'
    | 'plugin-capabilities'
    | 'capability-receipt'
    | 'projection-plan'
    | 'run-log'
    | 'projection-hook'
  message: string
}

export interface InterruptedTaskRunRecoveryReport {
  candidates: number
  appendedCloses: number
  closedPlans: number
  failures: InterruptedTaskRunRecoveryFailure[]
}

/**
 * Reconstructs daemon-owned settlement for Task runs left active by a
 * process crash. Each run is isolated: damaged artifact/plan/log state is
 * reported but never prevents another durable summary from being recovered.
 */
export async function recoverInterruptedTaskRuns(
  options: RecoverInterruptedTaskRunsOptions,
): Promise<InterruptedTaskRunRecoveryReport> {
  const candidates = await options.runLogs.prepareInterruptedRecovery()
  const report: InterruptedTaskRunRecoveryReport = {
    candidates: candidates.length,
    appendedCloses: 0,
    closedPlans: 0,
    failures: [],
  }

  for (const { summary } of candidates) {
    if (options.capabilityReceipt) {
      try {
        await options.capabilityReceipt(summary.runId, summary.capabilityReceiptDigest)
      } catch (error) {
        report.failures.push(failure(summary.runId, 'capability-receipt', error))
        continue
      }
    }
    try {
      // A terminal close is the authoritative settlement boundary. In
      // particular, a crash after close+materialization but before summary
      // rewrite must not downgrade the completed pending plan to partial.
      const existingClose = await options.runLogs.terminalClose(summary.runId)
      if (existingClose) {
        if (existingClose.projectionPlan && options.onProjectionPlanReady) {
          let record: ProjectionPlanRecord | undefined
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
              if (record.plan.taskProposals.length === 0) {
                await options
                  .projectionPlanStore(summary.canvasBranch ?? 'main')
                  .dismiss(record.plan.planId)
              }
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
    let manifest: ArtifactManifest | undefined
    let artifacts: string[] = []
    let projection: {
      plan: ProjectionPlanRecord['plan']
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
      let pluginCapabilities: RecoverableProjectionPluginCapabilitySnapshot = structuredClone(
        BUILTIN_PROJECTION_PLUGIN_CAPABILITY_SNAPSHOT,
      )
      if (options.pluginCapabilities) {
        try {
          pluginCapabilities = await options.pluginCapabilities(summary.pluginCapabilityDigest)
        } catch (error) {
          report.failures.push(failure(summary.runId, 'plugin-capabilities', error))
        }
      }
      try {
        const recovered = await options
          .projectionPlanStore(summary.canvasBranch ?? 'main')
          .recoverInterrupted({
            taskId: summary.taskId,
            runId: summary.runId,
            manifest,
            plugins: projectionPluginContracts(pluginCapabilities),
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
            if (projection.plan.taskProposals.length === 0) {
              await options
                .projectionPlanStore(summary.canvasBranch ?? 'main')
                .dismiss(projection.plan.planId)
            }
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
  record: ProjectionPlanRecord,
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
  record: ProjectionPlanRecord,
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
  stage: InterruptedTaskRunRecoveryFailure['stage'],
  error: unknown,
): InterruptedTaskRunRecoveryFailure {
  return {
    runId,
    stage,
    message: error instanceof Error ? error.message : String(error),
  }
}
