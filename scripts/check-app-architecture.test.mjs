import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

test('current application modules respect the declared architecture boundaries', () => {
  const result = spawnSync(process.execPath, ['scripts/check-app-architecture.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /Application architecture boundaries: 8 roots clean/)
  assert.match(result.stdout, /4 composition budgets clean/)
  assert.match(result.stdout, /3 capability runtime boundaries clean/)
})
