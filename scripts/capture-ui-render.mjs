import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'

const root = process.cwd()
const options = parseArguments(process.argv.slice(2))
const catalog = JSON.parse(await readFile(path.join(root, 'ui-render', 'scenarios.json'), 'utf8'))
if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.scenarios)) {
  throw new Error('ui-render/scenarios.json has an unsupported schema')
}
const scenarios = options.scenario
  ? catalog.scenarios.filter((scenario) => scenario.id === options.scenario)
  : catalog.scenarios
if (scenarios.length === 0) throw new Error(`Unknown UI render scenario: ${options.scenario}`)

const outputDir = path.resolve(root, options.output)
await rm(outputDir, { recursive: true, force: true })
await mkdir(outputDir, { recursive: true })

const server = options.baseUrl ? null : startVite(options.port)
const baseUrl = options.baseUrl ?? `http://127.0.0.1:${options.port}`
try {
  await waitForServer(`${baseUrl}/ui-render/index.html`)
  for (const scenario of scenarios) {
    const target = new URL('/ui-render/index.html', baseUrl)
    target.searchParams.set('scenario', scenario.id)
    const filename = path.join(outputDir, `${scenario.id}.png`)
    await runCommand(npxCommand(), [
      '--yes',
      'playwright@1.55.0',
      'screenshot',
      '--browser',
      'chromium',
      '--viewport-size',
      `${scenario.viewport.width},${scenario.viewport.height}`,
      '--wait-for-selector',
      "html[data-ui-render-ready='true']",
      '--wait-for-timeout',
      '150',
      target.toString(),
      filename,
    ])
  }
  await writeFile(
    path.join(outputDir, 'index.html'),
    renderGallery(scenarios),
    'utf8',
  )
  await writeFile(
    path.join(outputDir, 'manifest.json'),
    `${JSON.stringify({ schemaVersion: 1, scenarios }, null, 2)}\n`,
    'utf8',
  )
  process.stdout.write(`Captured ${scenarios.length} UI render(s) in ${outputDir}\n`)
} finally {
  if (server) await stopProcess(server)
}

function parseArguments(args) {
  const parsed = { output: 'artifacts/ui-render', port: 4173, baseUrl: '', scenario: '' }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--output') parsed.output = requiredValue(args, ++index, argument)
    else if (argument === '--port') parsed.port = Number(requiredValue(args, ++index, argument))
    else if (argument === '--base-url') parsed.baseUrl = requiredValue(args, ++index, argument)
    else if (argument === '--scenario') parsed.scenario = requiredValue(args, ++index, argument)
    else throw new Error(`Unknown argument: ${argument}`)
  }
  if (!Number.isInteger(parsed.port) || parsed.port < 1 || parsed.port > 65_535) {
    throw new Error(`Invalid UI render port: ${parsed.port}`)
  }
  return parsed
}

function requiredValue(args, index, argument) {
  const value = args[index]
  if (!value) throw new Error(`${argument} requires a value`)
  return value
}

function startVite(port) {
  return spawn(npmCommand(), [
    'run',
    'dev:frontend',
    '--',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--strictPort',
  ], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, NO_COLOR: '1' },
  })
}

async function waitForServer(url) {
  const deadline = Date.now() + 30_000
  let lastError
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
      lastError = new Error(`Vite returned ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await delay(200)
  }
  throw new Error(`UI render server did not become ready: ${String(lastError)}`)
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, NO_COLOR: '1' },
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} exited with code ${code}`))
    })
  })
}

async function stopProcess(child) {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise((resolve) => child.once('close', resolve)),
    delay(2_000),
  ])
  if (child.exitCode === null) child.kill('SIGKILL')
}

function renderGallery(scenarios) {
  const cards = scenarios.map((scenario) => `
    <figure>
      <img src="./${escapeHtml(scenario.id)}.png" alt="${escapeHtml(scenario.title)}" />
      <figcaption>${escapeHtml(scenario.title)} <code>${escapeHtml(scenario.id)}</code></figcaption>
    </figure>`).join('\n')
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>GGAI UI renders</title>
<style>body{font:14px system-ui;margin:24px;background:#f7f8fa;color:#172033}main{display:grid;gap:24px}figure{margin:0;padding:16px;background:white;border:1px solid #dfe3ea;border-radius:16px}img{display:block;max-width:100%;height:auto;margin:auto}figcaption{margin-top:12px;color:#667085}code{margin-left:8px}</style>
</head><body><main>${cards}</main></body></html>\n`
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function npxCommand() {
  return process.platform === 'win32' ? 'npx.cmd' : 'npx'
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
