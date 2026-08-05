import assert from 'node:assert/strict'
import { access, chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { AgentRegistry } from '../registry.js'

test('registry records the executable and rejects a CLI missing required capabilities', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ggai-registry-'))
  const fakeCodex = path.join(root, 'old-codex.mjs')
  await writeFile(fakeCodex, `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] === '--version') console.log('codex-cli 0.1.0')
else if (args[0] === 'login') console.log('Logged in')
else if (args[0] === 'exec') console.log('--json')
else process.exitCode = 2
`, 'utf8')
  await chmod(fakeCodex, 0o755)

  try {
    const registry = new AgentRegistry({
      codexCommand: fakeCodex,
      acpxCommand: path.join(root, 'missing-acpx'),
    })
    const codex = (await registry.probe()).find((agent) => agent.id === 'codex')
    assert.ok(codex)
    assert.equal(codex.available, false)
    assert.equal(codex.binaryPath, await realpath(fakeCodex))
    assert.match(codex.detail ?? '', /missing required CLI capabilities/u)
    assert.match(codex.detail ?? '', /--sandbox/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('registry never executes acpx until an adapter is explicitly configured', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ggai-registry-disabled-acpx-'))
  const fakeAcpx = path.join(root, 'fake-acpx.mjs')
  const marker = path.join(root, 'acpx-was-executed')
  await writeFile(fakeAcpx, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(marker)}, 'executed')
`, 'utf8')
  await chmod(fakeAcpx, 0o755)

  try {
    const registry = new AgentRegistry({
      codexCommand: path.join(root, 'missing-codex'),
      acpxCommand: fakeAcpx,
    })
    const descriptors = await registry.probe()
    assert.equal(descriptors.some((agent) => agent.transport === 'acpx'), false)
    await assert.rejects(access(marker), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('registry probes the selected acpx approval mode and each configured adapter', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ggai-registry-acpx-'))
  const fakeAcpx = path.join(root, 'fake-acpx.mjs')
  await writeFile(fakeAcpx, `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] === '--version') console.log('acpx 0.13.0')
else if (args[0] === '--help') console.log('--cwd --format --json-strict --non-interactive-permissions --approve-reads')
else if (args[0] === 'known' && args.includes('prompt')) console.log('-s --session')
else if (args[0] === 'known' && args.includes('ensure')) console.log('--name')
else if (args[0] === 'known' && args.includes('cancel')) console.log('-s --session')
else { console.error('unknown adapter'); process.exitCode = 2 }
`, 'utf8')
  await chmod(fakeAcpx, 0o755)

  try {
    const registry = new AgentRegistry({
      codexCommand: path.join(root, 'missing-codex'),
      acpxCommand: fakeAcpx,
      acpxAgents: ['known', 'missing'],
    })
    const descriptors = await registry.probe()
    assert.equal(descriptors.find((agent) => agent.id === 'acpx:known')?.available, true)
    const missing = descriptors.find((agent) => agent.id === 'acpx:missing')
    assert.equal(missing?.available, false)
    assert.match(missing?.detail ?? '', /unknown adapter/u)

    const approveAllRegistry = new AgentRegistry({
      codexCommand: path.join(root, 'missing-codex'),
      acpxCommand: fakeAcpx,
      acpxAgents: ['known'],
      acpxApprovalMode: 'approve-all',
    })
    const approveAll = (await approveAllRegistry.probe()).find((agent) => agent.id === 'acpx:known')
    assert.equal(approveAll?.available, false)
    assert.match(approveAll?.detail ?? '', /--approve-all/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
