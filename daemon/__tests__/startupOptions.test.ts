import assert from 'node:assert/strict'
import test from 'node:test'
import { DAEMON_HELP, parseDaemonConfig } from '../startupOptions.js'

test('production daemon startup always exposes Canvas without a model selector', () => {
  const config = parseDaemonConfig([], {
    GGAI_PROJECT_ROOT: '/tmp/ggai-v2-startup',
  })

  assert.ok(config)
  assert.equal('canvasModel' in config, false)
  assert.equal(config.projectRoot, '/tmp/ggai-v2-startup')
  assert.doesNotMatch(DAEMON_HELP, /V1|rollback|canvas-model/u)
  assert.match(DAEMON_HELP, /runs Canvas/u)
})

test('removed Canvas model CLI selection fails closed', () => {
  assert.throws(
    () => parseDaemonConfig(['--canvas-model', 'v1']),
    /unknown argument: --canvas-model/u,
  )
  assert.throws(
    () => parseDaemonConfig(['--canvas-model', 'v2']),
    /unknown argument: --canvas-model/u,
  )
})

test('daemon startup options remain strict and normalize repeated values', () => {
  const config = parseDaemonConfig([
    '--port', '7440',
    '--project-root', './fixture',
    '--allow-origin', 'http://localhost:3000',
    '--acpx-agent', 'codex',
    '--acpx-agent', 'codex',
    '--codex-command', '/opt/codex',
  ], {
    GGAI_ALLOWED_ORIGINS: 'http://127.0.0.1:3000',
  })

  assert.ok(config)
  assert.equal(config.port, 7440)
  assert.deepEqual(config.allowedOrigins, [
    'http://127.0.0.1:3000',
    'http://localhost:3000',
  ])
  assert.deepEqual(config.acpxAgents, ['codex'])
  assert.equal(config.codexCommand, '/opt/codex')
  assert.equal(parseDaemonConfig(['--help']), null)
  assert.throws(() => parseDaemonConfig(['--port', '0']), /invalid port/u)
})
