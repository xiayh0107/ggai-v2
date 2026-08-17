import { createHash } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { chromium } from 'playwright'
import { parseUiRenderCatalog } from './ui-render-catalog.mjs'

const root = process.cwd()
const options = parseArguments(process.argv.slice(2))
const catalog = parseUiRenderCatalog(JSON.parse(await readFile(
  path.join(root, 'ui-render', 'scenarios.json'),
  'utf8',
)))
const scenarios = options.scenario
  ? catalog.scenarios.filter((scenario) => scenario.id === options.scenario)
  : catalog.scenarios
if (scenarios.length === 0) throw new Error(`Unknown UI render scenario: ${options.scenario}`)

const source = sourceMetadata()
const outputDir = safeOutputDir(options.record && !options.outputExplicit
  ? path.join('artifacts', 'ui-render-runs', `${timestampSlug()}-${source.commit.slice(0, 8)}`)
  : options.output)
const baseline = options.baseline
  ? await readBaseline(path.resolve(root, options.baseline))
  : new Map()
if (options.baseline && path.resolve(root, options.baseline) === outputDir) {
  throw new Error('UI render baseline and output directories must differ')
}

await rm(outputDir, { recursive: true, force: true })
await mkdir(outputDir, { recursive: true })

const server = options.baseUrl ? null : startVite(options.port)
const baseUrl = options.baseUrl || `http://127.0.0.1:${options.port}`
const results = []
let browser
try {
  await waitForServer(`${baseUrl}/ui-render/index.html`)
  browser = await chromium.launch({ headless: true })
  for (const scenario of scenarios) {
    const result = await inspectScenario({
      browser,
      baseUrl,
      outputDir,
      scenario,
      checkOnly: options.checkOnly,
      baselineDigest: baseline.get(scenario.id),
    })
    results.push(result)
    process.stdout.write(`${result.status === 'passed' ? '✓' : '✗'} ${scenario.id} · ${result.checks.filter((check) => check.passed).length}/${result.checks.length} checks\n`)
  }
} finally {
  await browser?.close()
  if (server) await stopProcess(server)
}

const failed = results.filter((result) => result.status === 'failed')
const changed = results.filter((result) => result.comparison === 'changed')
const manifest = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  source,
  mode: options.checkOnly ? 'check' : options.record ? 'record' : 'capture',
  baseline: options.baseline ? path.resolve(root, options.baseline) : null,
  summary: {
    scenarios: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    changed: changed.length,
  },
  principles: catalog.principles,
  journeys: catalog.journeys,
  scenarios: results,
}
await writeFile(path.join(outputDir, 'index.html'), renderGallery(manifest), 'utf8')
await writeFile(
  path.join(outputDir, 'manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8',
)

process.stdout.write(`${options.checkOnly ? 'Checked' : 'Captured'} ${results.length} UI state(s) in ${outputDir}\n`)
if (failed.length > 0) {
  throw new Error(`${failed.length} UI render scenario(s) violated their design contract`)
}
if (options.failOnChange && changed.length > 0) {
  throw new Error(`${changed.length} UI render scenario(s) changed from the selected baseline`)
}

async function inspectScenario({
  browser: activeBrowser,
  baseUrl: activeBaseUrl,
  outputDir: activeOutputDir,
  scenario,
  checkOnly,
  baselineDigest,
}) {
  const page = await activeBrowser.newPage({
    viewport: scenario.viewport,
    colorScheme: 'light',
    reducedMotion: 'reduce',
  })
  const target = new URL('/ui-render/index.html', activeBaseUrl)
  target.searchParams.set('scenario', scenario.id)
  const checks = []
  let imageDigest = null
  let error = null
  try {
    await page.goto(target.toString(), { waitUntil: 'networkidle', timeout: 30_000 })
    await page.locator(scenario.readySelector).first().waitFor({
      state: 'visible',
      timeout: 15_000,
    })
    await page.evaluate(() => globalThis.document.fonts.ready)
    // Let React effects and portal placement settle after the semantic ready edge.
    await page.waitForTimeout(150)
    for (const check of scenario.checks) checks.push(await runUiCheck(page, check))
    if (!checkOnly) {
      const filename = path.join(activeOutputDir, `${scenario.id}.png`)
      await page.screenshot({
        path: filename,
        animations: 'disabled',
        caret: 'hide',
      })
      imageDigest = createHash('sha256').update(await readFile(filename)).digest('hex')
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause)
  } finally {
    await page.close()
  }

  const passed = error === null && checks.every((check) => check.passed)
  const comparison = !imageDigest || !baselineDigest
    ? baselineDigest ? 'missing' : 'untracked'
    : imageDigest === baselineDigest ? 'unchanged' : 'changed'
  return {
    ...scenario,
    status: passed ? 'passed' : 'failed',
    checks,
    error,
    image: checkOnly ? null : `${scenario.id}.png`,
    imageDigest,
    comparison,
  }
}

async function runUiCheck(page, check) {
  if (check.kind === 'selector-count') {
    const actual = await page.locator(check.selector).count()
    return { ...check, actual, passed: actual === check.count }
  }
  if (check.kind === 'selector-visible') {
    const locator = page.locator(check.selector)
    const actual = await locator.count()
    const passed = actual > 0 && await locator.first().isVisible()
    return { ...check, actual, passed }
  }
  const bodyText = await page.locator('body').innerText()
  const present = bodyText.includes(check.text)
  return {
    ...check,
    actual: present ? 'present' : 'absent',
    passed: check.kind === 'text-present' ? present : !present,
  }
}

function parseArguments(args) {
  const parsed = {
    output: 'artifacts/ui-render',
    outputExplicit: false,
    port: 4173,
    baseUrl: '',
    scenario: '',
    baseline: '',
    checkOnly: false,
    record: false,
    failOnChange: false,
  }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--output') {
      parsed.output = requiredValue(args, ++index, argument)
      parsed.outputExplicit = true
    } else if (argument === '--port') {
      parsed.port = Number(requiredValue(args, ++index, argument))
    } else if (argument === '--base-url') {
      parsed.baseUrl = requiredValue(args, ++index, argument)
    } else if (argument === '--scenario') {
      parsed.scenario = requiredValue(args, ++index, argument)
    } else if (argument === '--baseline') {
      parsed.baseline = requiredValue(args, ++index, argument)
    } else if (argument === '--check-only') {
      parsed.checkOnly = true
    } else if (argument === '--record') {
      parsed.record = true
    } else if (argument === '--fail-on-change') {
      parsed.failOnChange = true
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }
  if (!Number.isInteger(parsed.port) || parsed.port < 1 || parsed.port > 65_535) {
    throw new Error(`Invalid UI render port: ${parsed.port}`)
  }
  if (parsed.checkOnly && parsed.failOnChange) {
    throw new Error('--fail-on-change requires screenshots; remove --check-only')
  }
  return parsed
}

function requiredValue(args, index, argument) {
  const value = args[index]
  if (!value) throw new Error(`${argument} requires a value`)
  return value
}

function safeOutputDir(value) {
  const resolved = path.resolve(root, value)
  const relative = path.relative(root, resolved)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`UI render output must stay inside the repository: ${resolved}`)
  }
  return resolved
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

async function stopProcess(child) {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise((resolve) => child.once('close', resolve)),
    delay(2_000),
  ])
  if (child.exitCode === null) child.kill('SIGKILL')
}

async function readBaseline(directory) {
  try {
    const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'))
    return new Map((manifest.scenarios ?? [])
      .filter((scenario) => typeof scenario.id === 'string'
        && typeof scenario.imageDigest === 'string')
      .map((scenario) => [scenario.id, scenario.imageDigest]))
  } catch (cause) {
    throw new Error(`Cannot read UI render baseline at ${directory}: ${String(cause)}`)
  }
}

function sourceMetadata() {
  const commit = gitValue(['rev-parse', 'HEAD']) || 'unknown'
  return {
    commit,
    branch: gitValue(['branch', '--show-current']) || 'detached',
    dirty: Boolean(gitValue(['status', '--porcelain'])),
  }
}

function gitValue(args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function renderGallery(manifest) {
  const resultByJourney = new Map()
  for (const scenario of manifest.scenarios) {
    const current = resultByJourney.get(scenario.journeyId) ?? []
    current.push(scenario)
    resultByJourney.set(scenario.journeyId, current)
  }
  const sections = manifest.journeys.map((journey) => {
    const scenarios = (resultByJourney.get(journey.id) ?? [])
      .sort((left, right) => left.step - right.step)
    if (scenarios.length === 0) return ''
    const cards = scenarios.map(renderScenarioCard).join('\n')
    return `<section class="journey"><header><p>${escapeHtml(journey.label)}</p><span>${escapeHtml(journey.description)}</span></header><div class="cards">${cards}</div></section>`
  }).join('\n')
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GGAI UI 状态记录</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f5f7fa;color:#172033;font:14px system-ui,-apple-system,"PingFang SC",sans-serif}main{max-width:1480px;margin:auto;padding:28px}.summary{display:flex;align-items:flex-start;gap:16px;margin-bottom:28px}.summary h1{margin:0;font-size:22px}.summary p{margin:6px 0 0;color:#667085}.meta{margin-left:auto;text-align:right;color:#667085;font-size:12px}.journey{margin:28px 0}.journey>header{display:flex;align-items:baseline;gap:12px;margin-bottom:12px}.journey>header p{margin:0;font-weight:700}.journey>header span{color:#667085;font-size:12px}.cards{display:grid;gap:18px}.card{overflow:hidden;border:1px solid #dfe5ee;border-radius:16px;background:white}.card.failed{border-color:#f2b8b5}.card-head{display:flex;gap:16px;align-items:flex-start;padding:16px 18px;border-bottom:1px solid #e5e9f0}.step{display:grid;width:28px;height:28px;place-items:center;border-radius:50%;background:#1769e0;color:white;font-weight:700}.title{flex:1}.title h2{margin:0;font-size:14px}.title p{margin:5px 0 0;color:#667085;font-size:12px}.badge{border-radius:999px;padding:5px 9px;background:#e7f6ef;color:#147a50;font-size:11px}.failed .badge{background:#fff0ef;color:#b42318}.state{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:#e5e9f0}.state div{background:#f8fafc;padding:9px 12px}.state dt{color:#667085;font-size:10px}.state dd{margin:3px 0 0;font-size:11px;font-weight:600}.visual{padding:18px;background:#f7f9fc}.visual img{display:block;max-width:100%;height:auto;margin:auto;border:1px solid #e3e8ef;border-radius:12px;background:white}.checks{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:8px;padding:14px 18px}.check{display:flex;gap:8px;color:#475467;font-size:11px}.check i{font-style:normal;color:#147a50}.check.bad i{color:#b42318}.error{margin:0 18px 16px;padding:10px;border-radius:8px;background:#fff0ef;color:#b42318;font:11px ui-monospace,monospace}.comparison{margin-left:8px;color:#667085;font-size:10px}code{font-size:11px}
</style></head><body><main><div class="summary"><div><h1>本地 UI 状态记录</h1><p>${manifest.summary.passed}/${manifest.summary.scenarios} 个场景通过设计契约 · ${manifest.summary.changed} 个场景相对基线变化</p></div><div class="meta"><code>${escapeHtml(manifest.source.commit.slice(0, 12))}</code> · ${escapeHtml(manifest.source.branch)}${manifest.source.dirty ? ' · dirty' : ''}<br>${escapeHtml(manifest.generatedAt)}</div></div>${sections}</main></body></html>\n`
}

function renderScenarioCard(scenario) {
  const state = Object.entries({
    生命周期: scenario.state.phase,
    视觉选择: scenario.state.selection,
    控制归属: scenario.state.controlOwner,
    披露层级: scenario.state.disclosure,
  }).map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')
  const checks = scenario.checks.map((check) => `<div class="check${check.passed ? '' : ' bad'}"><i>${check.passed ? '✓' : '✕'}</i><span>${escapeHtml(check.label)}</span></div>`).join('')
  const visual = scenario.image
    ? `<div class="visual"><img src="./${escapeHtml(scenario.image)}" alt="${escapeHtml(scenario.title)}"></div>`
    : ''
  return `<article class="card ${scenario.status}"><div class="card-head"><span class="step">${scenario.step}</span><div class="title"><h2>${escapeHtml(scenario.title)} <code>${escapeHtml(scenario.id)}</code></h2><p>${escapeHtml(scenario.description)}</p></div><span class="badge">${scenario.status === 'passed' ? '契约通过' : '需要修复'}<span class="comparison">${comparisonLabel(scenario.comparison)}</span></span></div><dl class="state">${state}</dl>${visual}<div class="checks">${checks}</div>${scenario.error ? `<pre class="error">${escapeHtml(scenario.error)}</pre>` : ''}</article>`
}

function comparisonLabel(comparison) {
  if (comparison === 'changed') return '已变化'
  if (comparison === 'unchanged') return '无变化'
  if (comparison === 'missing') return '缺少截图'
  return '未比较'
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function timestampSlug() {
  return new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
