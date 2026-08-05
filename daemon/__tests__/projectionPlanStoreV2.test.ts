import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { buildArtifactManifestV1 } from '../artifactManifestV2.js'
import {
  ProjectionPlanConflictV2Error,
  ProjectionPlanNotFoundV2Error,
  ProjectionPlanNotPendingV2Error,
  ProjectionPlanStoreSnapshotV2Error,
  ProjectionPlanStoreV2,
} from '../projectionPlanStoreV2.js'
import type { BuildProjectionPlanV2Input } from '../projectionPlanV2.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })))
})

async function temporaryStorePath(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'ggai-plan-v2-store-'))
  temporaryDirectories.push(directory)
  return path.join(directory, 'nested', 'projection-plans.json')
}

function input(title = 'Preview'): BuildProjectionPlanV2Input {
  return {
    taskId: 'task-1',
    runId: 'run-1',
    runStatus: 'done',
    manifest: buildArtifactManifestV1({
      runId: 'run-1',
      complete: true,
      files: [{
        ownerRunId: 'run-1',
        relativePath: 'preview.png',
        kind: 'file',
        temporary: false,
        mediaType: 'image/png',
        size: 128,
        contentDigest: 'a'.repeat(64),
      }],
    }),
    plugins: [{
      id: 'image',
      artifactRules: [{ extensions: ['.png'], mediaTypes: ['image/*'] }],
    }],
    outcome: {
      schemaVersion: 2,
      suggestedActions: [{
        id: 'refine',
        label: 'Refine',
        prompt: 'Refine the generated preview.',
      }],
      outputs: [{
        key: 'preview',
        path: 'preview.png',
        pluginId: 'image',
        role: 'primary',
        title,
      }],
      taskProposals: [],
    },
  }
}

function interruptedInput(source = input()) {
  return {
    taskId: source.taskId,
    runId: source.runId,
    manifest: source.manifest,
    plugins: source.plugins,
  }
}

test('builds, persists, and reloads only a daemon-authored pending plan', async () => {
  const filePath = await temporaryStorePath()
  const store = new ProjectionPlanStoreV2(filePath, {
    now: () => Date.parse('2026-08-05T12:00:00.000Z'),
  })
  const created = await store.createPending(input())

  assert.equal(created.record.state, 'pending')
  assert.equal(created.record.plan.digest, created.plan.digest)
  assert.deepEqual(created.record.suggestedActions, created.suggestedActions)
  assert.equal(created.record.createdAt, Date.parse('2026-08-05T12:00:00.000Z'))
  assert.deepEqual(await store.requirePending(created.plan.planId), created.plan)
  assert.equal((await readFile(filePath, 'utf8')).endsWith('\n'), true)

  created.record.plan.outputs[0]!.title = 'caller mutation'
  assert.equal((await store.get(created.plan.planId))?.plan.outputs[0]?.title, 'Preview')

  const reopened = new ProjectionPlanStoreV2(filePath)
  assert.deepEqual(await reopened.requirePending(created.plan.planId), created.plan)
  assert.deepEqual((await reopened.get(created.plan.planId))?.suggestedActions, [{
    id: 'refine',
    label: 'Refine',
    prompt: 'Refine the generated preview.',
  }])
})

test('deduplicates the same trusted plan and rejects identity reuse with different content', async () => {
  const filePath = await temporaryStorePath()
  let now = 100
  const store = new ProjectionPlanStoreV2(filePath, { now: () => now })
  const first = await store.createPending(input())
  now = 200
  const retried = await store.createPending(input())

  assert.deepEqual(retried.record, first.record)
  await assert.rejects(
    store.createPending(input('Different trusted title')),
    ProjectionPlanConflictV2Error,
  )
  assert.equal((await store.get(first.plan.planId))?.plan.digest, first.plan.digest)
})

test('creates or replaces only a pending plan with the interrupted partial settlement', async () => {
  const filePath = await temporaryStorePath()
  let now = 100
  const store = new ProjectionPlanStoreV2(filePath, { now: () => now })
  const complete = await store.createPending(input())
  now = 200

  const recovered = await store.recoverInterrupted(interruptedInput())
  assert.equal(recovered.disposition, 'replaced-pending')
  assert.equal(recovered.record.state, 'pending')
  assert.equal(recovered.record.plan.status, 'partial')
  assert.notEqual(recovered.record.plan.digest, complete.plan.digest)
  assert.deepEqual(recovered.record.plan.taskProposals, [])
  assert.deepEqual(recovered.record.suggestedActions, [])
  assert.equal(recovered.record.createdAt, 100)
  assert.equal(recovered.record.updatedAt, 200)

  now = 300
  const replayed = await store.recoverInterrupted(interruptedInput())
  assert.equal(replayed.disposition, 'replaced-pending')
  assert.deepEqual(replayed.record, recovered.record)

  const freshPath = await temporaryStorePath()
  const fresh = await new ProjectionPlanStoreV2(freshPath, { now: () => 400 })
    .recoverInterrupted(interruptedInput())
  assert.equal(fresh.disposition, 'created')
  assert.equal(fresh.record.plan.status, 'partial')
})

test('dismisses idempotently and never resurrects a closed plan', async () => {
  const filePath = await temporaryStorePath()
  let now = 100
  const store = new ProjectionPlanStoreV2(filePath, { now: () => now })
  const created = await store.createPending(input())
  now = 250

  const dismissed = await store.dismiss(created.plan.planId)
  assert.equal(dismissed.state, 'dismissed')
  assert.equal(dismissed.updatedAt, 250)
  await assert.rejects(
    store.requirePending(created.plan.planId),
    ProjectionPlanNotPendingV2Error,
  )

  now = 500
  assert.deepEqual(await store.dismiss(created.plan.planId), dismissed)
  await assert.rejects(
    store.createPending(input()),
    ProjectionPlanNotPendingV2Error,
  )
  const recovered = await store.recoverInterrupted(interruptedInput())
  assert.equal(recovered.disposition, 'closed')
  assert.deepEqual(recovered.record, dismissed)
  assert.equal((await store.get(created.plan.planId))?.updatedAt, 250)
})

test('rejects unknown plan ids and invalid stored data without overwriting it', async () => {
  const filePath = await temporaryStorePath()
  const store = new ProjectionPlanStoreV2(filePath)
  const missingPlanId = `plan_${'f'.repeat(64)}`
  await assert.rejects(store.requirePending(missingPlanId), ProjectionPlanNotFoundV2Error)
  await assert.rejects(store.dismiss(missingPlanId), ProjectionPlanNotFoundV2Error)
  await assert.rejects(store.get('client-selected-plan'), /planId is invalid/u)

  await mkdir(path.dirname(filePath), { recursive: true })
  const invalidSource = JSON.stringify({ schemaVersion: 2, records: { malicious: {} } })
  await writeFile(filePath, invalidSource, 'utf8')
  const reopened = new ProjectionPlanStoreV2(filePath)
  await assert.rejects(reopened.get(missingPlanId), ProjectionPlanStoreSnapshotV2Error)
  assert.equal(await readFile(filePath, 'utf8'), invalidSource)
})

test('refuses a symlinked pending-plan store instead of following it', async () => {
  const filePath = await temporaryStorePath()
  const outsidePath = path.join(path.dirname(path.dirname(filePath)), 'outside.json')
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(outsidePath, '{}', 'utf8')
  await symlink(outsidePath, filePath)

  const store = new ProjectionPlanStoreV2(filePath)
  await assert.rejects(
    store.get(`plan_${'a'.repeat(64)}`),
    /must not be a symlink/u,
  )
  assert.equal(await readFile(outsidePath, 'utf8'), '{}')
})
