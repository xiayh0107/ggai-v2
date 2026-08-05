import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'

import { WorkspacePreferencesManager } from '../preferences.js'
import { ProtocolError } from '../protocol.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })))
})

async function temporaryProject(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'ggai-preferences-'))
  temporaryDirectories.push(directory)
  return directory
}

test('workspace preferences default to confirm and persist atomically', async () => {
  const projectDir = await temporaryProject()
  const first = new WorkspacePreferencesManager(projectDir)

  assert.deepEqual(await first.get('.'), {
    schemaVersion: 1,
    automationMode: 'confirm',
  })
  assert.deepEqual(await first.put('.', { automationMode: 'auto' }), {
    schemaVersion: 1,
    automationMode: 'auto',
  })
  await first.close()

  const reopened = new WorkspacePreferencesManager(projectDir)
  assert.equal((await reopened.get('.')).automationMode, 'auto')
  await reopened.close()
})

test('workspace preferences reject invalid modes, traversal, and use after close', async () => {
  const projectDir = await temporaryProject()
  const preferences = new WorkspacePreferencesManager(projectDir)

  await assert.rejects(
    preferences.put('.', { automationMode: 'unrestricted' }),
    (error: unknown) => error instanceof ProtocolError,
  )
  await assert.rejects(preferences.get('..'), /outside configured root/u)
  await preferences.close()
  await assert.rejects(
    preferences.get('.'),
    (error: unknown) => error instanceof ProtocolError && error.code === 'daemon_shutting_down',
  )
})

test('workspace preferences reject a .gg symlink before writing outside the project', async () => {
  const projectDir = await temporaryProject()
  const outside = await temporaryProject()
  await symlink(outside, path.join(projectDir, '.gg'), 'dir')
  const preferences = new WorkspacePreferencesManager(projectDir)

  await assert.rejects(
    preferences.put('.', { automationMode: 'auto' }),
    (error: unknown) => error instanceof ProtocolError && error.code === 'unsafe_managed_path',
  )
  assert.deepEqual(await readdir(outside), [])
})

test('workspace preferences reject redirects to another location inside .gg', async () => {
  const projectDir = await temporaryProject()
  const runtimeDir = path.join(projectDir, '.gg', 'runtime')
  const redirectedDir = path.join(projectDir, '.gg', 'redirected')
  const redirectedFile = path.join(redirectedDir, 'preferences.json')
  await Promise.all([
    mkdir(runtimeDir, { recursive: true }),
    mkdir(redirectedDir, { recursive: true }),
  ])
  await writeFile(
    redirectedFile,
    '{"schemaVersion":1,"automationMode":"confirm"}\n',
    'utf8',
  )
  await symlink(redirectedFile, path.join(runtimeDir, 'preferences.json'))

  const preferences = new WorkspacePreferencesManager(projectDir)
  await assert.rejects(
    preferences.get('.'),
    (error: unknown) => error instanceof ProtocolError && error.code === 'unsafe_managed_path',
  )
  await assert.rejects(
    preferences.put('.', { automationMode: 'auto' }),
    (error: unknown) => error instanceof ProtocolError && error.code === 'unsafe_managed_path',
  )
  assert.equal(
    await readFile(redirectedFile, 'utf8'),
    '{"schemaVersion":1,"automationMode":"confirm"}\n',
  )
  await preferences.close()
})
