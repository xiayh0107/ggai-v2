import type {
  CanvasCommandV2,
  TrustedProjectionPlanInputV2,
} from '../src/canvas-v2/commands.js'
import type { CanvasDocumentV2 } from '../src/canvas-v2/model.js'
import type {
  CanvasCommandWireV2,
} from './canvasCommandProtocolV2.js'
import type { CanvasEnvelopeV2 } from './canvasCommandStoreV2.js'
import type { ProjectionPlanV2, ProjectionSettlementV2 } from './projectionPlanV2.js'
import type { ProjectionPlanLifecycleV2 } from './projectionPlanStoreV2.js'

type TrustedPlanWireCommandV2 = Extract<CanvasCommandWireV2, {
  type: 'MaterializeProjectionPlan' | 'AcceptTaskProposals' | 'DismissPlan'
}>

export interface ProjectionPlanRecordLookupV2 extends ProjectionSettlementV2 {
  state: ProjectionPlanLifecycleV2
}

export interface ProjectionPlanRegistryV2 {
  getProjectionPlanRecord(
    planId: string,
    projectDir: string,
    canvasBranch: string,
  ): Promise<ProjectionPlanRecordLookupV2 | null>
  dismissProjectionPlan(
    planId: string,
    projectDir: string,
    canvasBranch: string,
  ): Promise<boolean>
}

/**
 * Structural persistence boundary used by both the raw command store tests and
 * the production WorkspaceVersionManagerV2 coordinator. Production must pass
 * the latter so trusted settlement commands participate in checkpointing.
 */
export interface CanvasProjectionCommitterV2 {
  get(projectDir: string, branch: string): Promise<CanvasEnvelopeV2>
  commit(
    projectDir: string,
    branch: string,
    baseRevision: number,
    mutationId: string,
    command: CanvasCommandV2,
  ): Promise<CanvasEnvelopeV2>
  commitLatest(
    projectDir: string,
    branch: string,
    mutationId: string,
    command: CanvasCommandV2,
  ): Promise<CanvasEnvelopeV2>
}

export interface CommitProjectionPlanCommandV2Input {
  canvases: CanvasProjectionCommitterV2
  plans: ProjectionPlanRegistryV2
  projectDir: string
  branch: string
  baseRevision: number
  mutationId: string
  command: TrustedPlanWireCommandV2
}

export class ProjectionPlanUnavailableV2Error extends Error {
  readonly planId: string
  readonly reason: 'missing' | 'settled'

  constructor(planId: string, reason: 'missing' | 'settled') {
    super(reason === 'missing'
      ? `Projection plan was not found: ${planId}`
      : `Projection plan is no longer pending: ${planId}`)
    this.name = 'ProjectionPlanUnavailableV2Error'
    this.planId = planId
    this.reason = reason
  }
}

/**
 * Resolves an opaque browser plan id to daemon-owned trusted data, then applies
 * the command through the ordinary Canvas CAS boundary.
 */
export async function commitProjectionPlanCommandV2(
  input: CommitProjectionPlanCommandV2Input,
): Promise<CanvasEnvelopeV2> {
  const record = await input.plans.getProjectionPlanRecord(
    input.command.planId,
    input.projectDir,
    input.branch,
  )
  if (!record) throw new ProjectionPlanUnavailableV2Error(input.command.planId, 'missing')

  const current = await input.canvases.get(input.projectDir, input.branch)
  if (planCommandAlreadySatisfied(current.document, input.command, record.plan)) {
    if (input.command.type !== 'MaterializeProjectionPlan' && record.state === 'pending') {
      await input.plans.dismissProjectionPlan(
        input.command.planId,
        input.projectDir,
        input.branch,
      )
    }
    return current
  }
  if (record.state !== 'pending') {
    throw new ProjectionPlanUnavailableV2Error(input.command.planId, 'settled')
  }

  const trustedCommand = trustedCanvasCommand(record.plan, input.command)
  const committed = await input.canvases.commit(
    input.projectDir,
    input.branch,
    input.baseRevision,
    input.mutationId,
    trustedCommand,
  )
  // Canvas receipts are the first durable fact. If lifecycle settlement fails,
  // replay observes the receipt, repairs the registry, and creates no entities.
  if (input.command.type !== 'MaterializeProjectionPlan') {
    await input.plans.dismissProjectionPlan(
      input.command.planId,
      input.projectDir,
      input.branch,
    )
  }
  return committed
}

/** Materializes a plan only after RunManager has durably appended its close. */
export async function autoMaterializeProjectionPlanV2(input: {
  canvases: CanvasProjectionCommitterV2
  projectDir: string
  branch: string
  plan: ProjectionPlanV2
}): Promise<CanvasEnvelopeV2> {
  return input.canvases.commitLatest(
    input.projectDir,
    input.branch,
    `projection:${input.plan.planId}`,
    { type: 'MaterializeProjectionPlan', plan: structuredClone(input.plan) },
  )
}

function trustedCanvasCommand(
  plan: ProjectionPlanV2,
  command: TrustedPlanWireCommandV2,
): CanvasCommandV2 {
  const trustedPlan = structuredClone(plan) as TrustedProjectionPlanInputV2
  if (command.type === 'MaterializeProjectionPlan') {
    return { type: command.type, plan: trustedPlan }
  }
  if (command.type === 'DismissPlan') {
    return { type: command.type, plan: trustedPlan }
  }
  return {
    type: command.type,
    plan: trustedPlan,
    proposalKeys: [...command.proposalKeys],
    ...(command.edits === undefined ? {} : { edits: structuredClone(command.edits) }),
  }
}

function planCommandAlreadySatisfied(
  document: CanvasDocumentV2,
  command: TrustedPlanWireCommandV2,
  plan: ProjectionPlanV2,
): boolean {
  const receipts = document.receipts.filter((receipt) => receipt.planId === plan.planId)
  if (receipts.some((receipt) => receipt.runId !== plan.runId || receipt.taskId !== plan.taskId)) {
    throw new TypeError(`projection plan receipt identity conflicts with ${plan.planId}`)
  }
  if (command.type === 'MaterializeProjectionPlan') {
    return receipts.some((receipt) =>
      receipt.kind === 'materialization' || receipt.kind === 'plan-dismissal')
  }
  if (command.type === 'AcceptTaskProposals') {
    return receipts.some((receipt) =>
      receipt.kind === 'proposal-acceptance' || receipt.kind === 'plan-dismissal')
  }
  return receipts.some((receipt) => receipt.kind === 'plan-dismissal')
}
