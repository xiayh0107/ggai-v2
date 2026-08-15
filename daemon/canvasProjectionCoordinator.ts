import type {
  CanvasCommand,
  TrustedProjectionPlanInput,
} from '../src/canvas/commands.js'
import type { CanvasDocument } from '../src/canvas/model.js'
import type {
  CanvasCommandWire,
} from './canvasCommandProtocol.js'
import type { CanvasEnvelope } from './canvasCommandStore.js'
import type { ProjectionPlan, ProjectionSettlement } from './projectionPlan.js'
import type { ProjectionPlanLifecycle } from './projectionPlanStore.js'

type TrustedPlanWireCommand = Extract<CanvasCommandWire, {
  type: 'MaterializeProjectionPlan' | 'AcceptTaskProposals' | 'DismissPlan'
}>

export interface ProjectionPlanRecordLookup extends ProjectionSettlement {
  state: ProjectionPlanLifecycle
}

export interface ProjectionPlanRegistry {
  getProjectionPlanRecord(
    planId: string,
    projectDir: string,
    canvasBranch: string,
  ): Promise<ProjectionPlanRecordLookup | null>
  dismissProjectionPlan(
    planId: string,
    projectDir: string,
    canvasBranch: string,
  ): Promise<boolean>
}

/**
 * Structural persistence boundary used by both the raw command store tests and
 * the production WorkspaceVersionManager coordinator. Production must pass
 * the latter so trusted settlement commands participate in checkpointing.
 */
export interface CanvasProjectionCommitter {
  get(projectDir: string, branch: string): Promise<CanvasEnvelope>
  commit(
    projectDir: string,
    branch: string,
    baseRevision: number,
    mutationId: string,
    command: CanvasCommand,
  ): Promise<CanvasEnvelope>
  commitLatest(
    projectDir: string,
    branch: string,
    mutationId: string,
    command: CanvasCommand,
  ): Promise<CanvasEnvelope>
}

export interface CommitProjectionPlanCommandInput {
  canvases: CanvasProjectionCommitter
  plans: ProjectionPlanRegistry
  projectDir: string
  branch: string
  baseRevision: number
  mutationId: string
  command: TrustedPlanWireCommand
}

export class ProjectionPlanUnavailableError extends Error {
  readonly planId: string
  readonly reason: 'missing' | 'settled'

  constructor(planId: string, reason: 'missing' | 'settled') {
    super(reason === 'missing'
      ? `Projection plan was not found: ${planId}`
      : `Projection plan is no longer pending: ${planId}`)
    this.name = 'ProjectionPlanUnavailableError'
    this.planId = planId
    this.reason = reason
  }
}

/**
 * Resolves an opaque browser plan id to daemon-owned trusted data, then applies
 * the command through the ordinary Canvas CAS boundary.
 */
export async function commitProjectionPlanCommand(
  input: CommitProjectionPlanCommandInput,
): Promise<CanvasEnvelope> {
  const record = await input.plans.getProjectionPlanRecord(
    input.command.planId,
    input.projectDir,
    input.branch,
  )
  if (!record) throw new ProjectionPlanUnavailableError(input.command.planId, 'missing')

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
    throw new ProjectionPlanUnavailableError(input.command.planId, 'settled')
  }

  const trustedCommand = trustedCanvasCommandFromPlan(record.plan, input.command)
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
export async function autoMaterializeProjectionPlan(input: {
  canvases: CanvasProjectionCommitter
  projectDir: string
  branch: string
  plan: ProjectionPlan
}): Promise<CanvasEnvelope> {
  return input.canvases.commitLatest(
    input.projectDir,
    input.branch,
    `projection:${input.plan.planId}`,
    { type: 'MaterializeProjectionPlan', plan: structuredClone(input.plan) },
  )
}

export function trustedCanvasCommandFromPlan(
  plan: ProjectionPlan,
  command: TrustedPlanWireCommand,
): CanvasCommand {
  const trustedPlan = structuredClone(plan) as TrustedProjectionPlanInput
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
  document: CanvasDocument,
  command: TrustedPlanWireCommand,
  plan: ProjectionPlan,
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
