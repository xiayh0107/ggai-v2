import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('CLI package metadata points every entry at the bundled ggai executable', async () => {
  const packageJson = JSON.parse(await readFile(
    new URL('../package.json', import.meta.url),
    'utf8',
  ))

  assert.deepEqual(packageJson.bin, {
    ggai: 'dist-cli/ggai.js',
    gg: 'dist-cli/ggai.js',
  })
  assert.match(packageJson.scripts.cli, /node dist-cli\/ggai\.js$/u)
  assert.match(packageJson.scripts.prepare, /build:daemon/u)
  assert.match(packageJson.scripts.prepare, /build:cli/u)
})
