import { readdir, readFile } from 'node:fs/promises'
import { extname, join, relative, sep } from 'node:path'
import process from 'node:process'
import {
  CAPABILITY_BOUNDARY_GROUP_COUNT,
  capabilityBoundaryViolations,
} from './capability-architecture-rules.mjs'

const ROOT = process.cwd()
const CHECKED_ROOTS = [
  'src/agent',
  'src/canvas',
  'src/components/canvas',
  'src/node-studio',
  'src/plugins',
  'src/resources',
  'src/workspace',
  'daemon',
]
const LEGACY_IMPORTS = [
  '@/hooks/useCanvasStore',
  '@/persistence/canvasPersistence',
  '@/types/canvas',
]
const VERSIONED_PRODUCT_LAYER = /(?:^|\/)(?:canvas-v\d+|components\/canvas-v\d+)(?:\/|$)|\bCanvasV\d+\b/u
const PLUGIN_VIEW_ESCAPE_HATCH = /\bviews\s*:\s*\{/su
const FILE_LINE_BUDGETS = new Map([
  ['src/components/canvas/CanvasStage.tsx', 2_150],
  ['src/components/canvas/CanvasContextComposer.tsx', 620],
  ['src/pages/ResourceLibrary.tsx', 120],
  ['src/pages/Workspace.tsx', 500],
])
const CAPABILITY_RUNTIME_LINE_BUDGETS = new Map([
  ['daemon/registry.ts', 60],
  ['daemon/agentRuntime.ts', 100],
  ['daemon/runtime/composition.ts', 230],
  ['daemon/runtime/pluginHost.ts', 360],
  ['daemon/runtime/services.ts', 160],
])

const violations = []
for (const root of CHECKED_ROOTS) {
  for (const file of await sourceFiles(join(ROOT, root))) {
    const source = await readFile(file, 'utf8')
    const sourcePath = portablePath(relative(ROOT, file))
    if (VERSIONED_PRODUCT_LAYER.test(sourcePath)) {
      violations.push(`${sourcePath} restores a versioned product layer`)
    }
    if (!/\.test\.[cm]?[jt]sx?$/u.test(file) && PLUGIN_VIEW_ESCAPE_HATCH.test(source)) {
      violations.push(`${sourcePath} restores a plugin component escape hatch`)
    }
    const imports = importedSpecifiers(source)
    violations.push(...capabilityBoundaryViolations(sourcePath, imports))
    for (const specifier of imports) {
      if (LEGACY_IMPORTS.some((legacy) => specifier.startsWith(legacy))) {
        violations.push(`${sourcePath} imports legacy module ${specifier}`)
      }
      if (VERSIONED_PRODUCT_LAYER.test(specifier)) {
        violations.push(`${sourcePath} imports versioned product layer ${specifier}`)
      }
      if (specifier.startsWith('@/pages/')) {
        violations.push(`${sourcePath} imports composition layer ${specifier}`)
      }
      if (!/\.test\.[cm]?[jt]sx?$/u.test(file) && specifier === '@/agent/daemonClient') {
        violations.push(`${sourcePath} imports the legacy aggregate daemon client`)
      }
    }
  }
}
for (const [path, maximumLines] of FILE_LINE_BUDGETS) {
  checkLineBudget(path, maximumLines, 'composition')
}
for (const [path, maximumLines] of CAPABILITY_RUNTIME_LINE_BUDGETS) {
  checkLineBudget(path, maximumLines, 'capability runtime')
}

async function checkLineBudget(path, maximumLines, label) {
  const source = await readFile(join(ROOT, path), 'utf8')
  const lineCount = source.endsWith('\n')
    ? source.split(/\r?\n/u).length - 1
    : source.split(/\r?\n/u).length
  if (lineCount > maximumLines) {
    violations.push(`${path} has ${lineCount} lines; ${label} budget is ${maximumLines}`)
  }
}

if (violations.length > 0) {
  console.error('Application architecture boundary violations:')
  for (const violation of violations) console.error(`- ${violation}`)
  process.exitCode = 1
} else {
  console.log(
    `Application architecture boundaries: ${CHECKED_ROOTS.length} roots clean; `
    + `${FILE_LINE_BUDGETS.size} composition budgets clean; `
    + `${CAPABILITY_RUNTIME_LINE_BUDGETS.size} capability runtime budgets clean; `
    + `${CAPABILITY_BOUNDARY_GROUP_COUNT} capability runtime boundaries clean`,
  )
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await sourceFiles(path))
    else if (entry.isFile() && ['.ts', '.tsx'].includes(extname(entry.name))) files.push(path)
  }
  return files
}

function importedSpecifiers(source) {
  const imports = []
  const staticPattern = /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g
  const dynamicPattern = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const match of source.matchAll(staticPattern)) imports.push(match[1])
  for (const match of source.matchAll(dynamicPattern)) imports.push(match[1])
  return imports
}

function portablePath(path) {
  return path.split(sep).join('/')
}
