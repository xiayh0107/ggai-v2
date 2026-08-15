import assert from 'node:assert/strict'
import { test } from 'node:test'
import { capabilityBoundaryViolations } from './capability-architecture-rules.mjs'

test('runtime primitives depend only on node builtins and sibling runtime modules', () => {
  assert.deepEqual(capabilityBoundaryViolations(
    'daemon/runtime/pluginHost.ts',
    ['./effects.js', './services.js', 'node:crypto'],
  ), [])
  assert.equal(capabilityBoundaryViolations(
    'daemon/runtime/pluginHost.ts',
    ['../protocol.js'],
  ).length, 1)
  assert.equal(capabilityBoundaryViolations(
    'daemon/runtime/pluginHost.ts',
    ['some-package'],
  ).length, 1)
})

test('runtime plugins cannot import browser code or trusted kernel writers', () => {
  assert.deepEqual(capabilityBoundaryViolations(
    'daemon/plugins/agentTransport/codex.ts',
    ['../../runtime/pluginHost.js', '../../transport/codex.js', 'node:path'],
  ), [])
  assert.equal(capabilityBoundaryViolations(
    'daemon/plugins/example.ts',
    ['../../src/components/canvas/CanvasStage.js'],
  ).length, 1)
  assert.equal(capabilityBoundaryViolations(
    'daemon/plugins/example.ts',
    ['../canvasCommandStore.js'],
  ).length, 1)
  assert.equal(capabilityBoundaryViolations(
    'daemon/plugins/example.tsx',
    ['react'],
  ).length, 2)
})

test('generic Agent transport registry cannot depend on concrete providers', () => {
  assert.deepEqual(capabilityBoundaryViolations(
    'daemon/transport/registry.ts',
    ['../runtime/services.js', '../protocol.js', './types.js'],
  ), [])
  assert.equal(capabilityBoundaryViolations(
    'daemon/transport/registry.ts',
    ['./codex.js'],
  ).length, 1)
  assert.equal(capabilityBoundaryViolations(
    'daemon/transport/registry.ts',
    ['../plugins/agentTransport/acpx.js'],
  ).length, 1)
})
