import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import {
  parseViteServerOptions,
  resolveCodexCommand,
  viteBrowserOrigins,
} from './dev-all-options.mjs'

test('uses the configured Vite defaults', () => {
  assert.deepEqual(parseViteServerOptions([]), { host: 'localhost', port: 3000 })
  assert.deepEqual(viteBrowserOrigins([]), [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://[::1]:3000',
  ])
})

test('derives exact loopback origins from either Vite port syntax', () => {
  for (const args of [['--port', '7100'], ['--port=7100']]) {
    assert.deepEqual(viteBrowserOrigins(args), [
      'http://localhost:7100',
      'http://127.0.0.1:7100',
      'http://[::1]:7100',
    ])
  }
})

test('matches Vite host parsing and lets the last option win', () => {
  assert.deepEqual(
    parseViteServerOptions(['--host', '127.0.0.1', '--port=4100', '--port', '7100']),
    { host: '127.0.0.1', port: 7100 },
  )
  assert.deepEqual(parseViteServerOptions(['--host', '--strictPort']), {
    host: '0.0.0.0',
    port: 3000,
  })
  assert.deepEqual(parseViteServerOptions(['--port', '7100', '--', '--port', '9000']), {
    host: 'localhost',
    port: 7100,
  })
})

test('includes an explicitly requested non-loopback Vite host', () => {
  assert.deepEqual(viteBrowserOrigins(['--host=dev.local', '--port=7100']), [
    'http://localhost:7100',
    'http://127.0.0.1:7100',
    'http://[::1]:7100',
    'http://dev.local:7100',
  ])
  assert.ok(viteBrowserOrigins(['--host=0.0.0.0', '--port=7100'])
    .includes('http://0.0.0.0:7100'))
  assert.deepEqual(viteBrowserOrigins(['--port=80']).slice(0, 3), [
    'http://localhost',
    'http://127.0.0.1',
    'http://[::1]',
  ])
})

test('rejects invalid Vite ports before starting either process', () => {
  for (const args of [['--port'], ['--port', 'nope'], ['--port=0'], ['--port=65536']]) {
    assert.throws(() => parseViteServerOptions(args), /Vite --port/u)
  }
})

test('an explicit Codex command always wins', () => {
  assert.equal(resolveCodexCommand({
    explicitCommand: ' /custom/codex ',
    pathValue: '/first:/brew',
    executable: () => true,
  }), '/custom/codex')
})

test('prefers an existing Homebrew-managed Codex over a stale earlier shim', () => {
  const separator = path.delimiter
  const executable = (filename) => filename === path.join('/brew/bin', 'brew')
    || filename === path.join('/brew/bin', 'codex')
    || filename === path.join('/old/bin', 'codex')
  assert.equal(resolveCodexCommand({
    pathValue: ['/old/bin', '/brew/bin'].join(separator),
    platform: 'darwin',
    executable,
  }), path.join('/brew/bin', 'codex'))
})

test('falls back to the first executable on PATH without guessing an install directory', () => {
  assert.equal(resolveCodexCommand({
    pathValue: ['/first/bin', '/second/bin'].join(path.delimiter),
    platform: 'darwin',
    executable: (filename) => filename === path.join('/second/bin', 'codex'),
  }), path.join('/second/bin', 'codex'))
  assert.equal(resolveCodexCommand({
    pathValue: '/old/bin',
    platform: 'darwin',
    executable: () => false,
  }), 'codex')
  assert.equal(resolveCodexCommand({
    pathValue: 'C:\\bin',
    platform: 'win32',
    executable: () => true,
  }), 'codex')
})

test('falls back to well-known install paths when PATH has no Codex', () => {
  // GUI launchers can hand npm a minimal PATH without any bin directory;
  // the daemon must still find an existing Homebrew Codex by absolute path.
  assert.equal(resolveCodexCommand({
    pathValue: '/usr/bin:/bin',
    platform: 'darwin',
    executable: (filename) => filename === '/opt/homebrew/bin/codex',
  }), '/opt/homebrew/bin/codex')
  assert.equal(resolveCodexCommand({
    pathValue: '/usr/bin:/bin',
    platform: 'darwin',
    executable: (filename) => filename === '/usr/local/bin/codex',
  }), '/usr/local/bin/codex')
  // A PATH hit still wins over the well-known fallbacks.
  assert.equal(resolveCodexCommand({
    pathValue: '/custom/bin',
    platform: 'darwin',
    executable: (filename) => filename === path.join('/custom/bin', 'codex')
      || filename === '/opt/homebrew/bin/codex',
  }), path.join('/custom/bin', 'codex'))
})
