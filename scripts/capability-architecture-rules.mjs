import { posix } from 'node:path'

export const CAPABILITY_BOUNDARY_GROUP_COUNT = 3

const UI_PACKAGES = /^(?:react(?:-dom)?|lucide-react)(?:\/|$)/u
const TRUSTED_KERNEL_MODULES = new Set([
  'daemon/canvasCommandStore',
  'daemon/canvasCommandStoreManager',
  'daemon/canvasGit',
  'daemon/canvasProjectionCoordinator',
  'daemon/nodeDefinitionCatalog',
  'daemon/permissions',
  'daemon/pluginCapabilities',
  'daemon/projectCatalog',
  'daemon/projectLease',
  'daemon/projectionPlan',
  'daemon/projectionPlanStore',
  'daemon/runArtifactStorage',
  'daemon/runLogs',
  'daemon/runs',
  'daemon/server',
  'daemon/skillAssets',
  'daemon/taskSessions',
  'daemon/workspaceVersioning',
])
const CONCRETE_AGENT_TRANSPORT_MODULES = new Set([
  'daemon/agentRuntime',
  'daemon/registry',
  'daemon/transport/acpx',
  'daemon/transport/codex',
])

export function capabilityBoundaryViolations(sourcePath, imports) {
  const path = portablePath(sourcePath)
  const violations = []
  if (path.startsWith('daemon/runtime/')) {
    violations.push(...runtimeLayerViolations(path, imports))
  }
  if (path.startsWith('daemon/plugins/')) {
    violations.push(...runtimePluginViolations(path, imports))
  }
  if (path === 'daemon/transport/registry.ts') {
    violations.push(...transportRegistryViolations(path, imports))
  }
  return violations
}

function runtimeLayerViolations(sourcePath, imports) {
  const violations = []
  if (sourcePath.endsWith('.tsx')) {
    violations.push(`${sourcePath} places browser UI code inside daemon/runtime`)
  }
  for (const specifier of imports) {
    if (specifier.startsWith('node:')) continue
    const resolved = resolvedProjectModule(sourcePath, specifier)
    if (!resolved?.startsWith('daemon/runtime/')) {
      violations.push(
        `${sourcePath} imports ${specifier}; daemon/runtime may depend only on node: modules and itself`,
      )
    }
  }
  return violations
}

function runtimePluginViolations(sourcePath, imports) {
  const violations = []
  if (sourcePath.endsWith('.tsx')) {
    violations.push(`${sourcePath} places browser UI code inside daemon/plugins`)
  }
  for (const specifier of imports) {
    if (specifier.startsWith('@/') || UI_PACKAGES.test(specifier)) {
      violations.push(`${sourcePath} imports browser/UI module ${specifier}`)
      continue
    }
    const resolved = resolvedProjectModule(sourcePath, specifier)
    if (!resolved) continue
    if (resolved.startsWith('src/')) {
      violations.push(`${sourcePath} imports browser source module ${specifier}`)
      continue
    }
    const stem = stripModuleExtension(resolved)
    if (TRUSTED_KERNEL_MODULES.has(stem)) {
      violations.push(`${sourcePath} imports trusted kernel authority ${specifier}`)
    }
  }
  return violations
}

function transportRegistryViolations(sourcePath, imports) {
  const violations = []
  for (const specifier of imports) {
    const resolved = resolvedProjectModule(sourcePath, specifier)
    if (!resolved) continue
    const stem = stripModuleExtension(resolved)
    if (stem.startsWith('daemon/plugins/') || CONCRETE_AGENT_TRANSPORT_MODULES.has(stem)) {
      violations.push(`${sourcePath} imports concrete transport/plugin module ${specifier}`)
    }
  }
  return violations
}

function resolvedProjectModule(sourcePath, specifier) {
  if (!specifier.startsWith('.')) return null
  return posix.normalize(posix.join(posix.dirname(sourcePath), specifier))
}

function stripModuleExtension(path) {
  return path.replace(/\.(?:[cm]?[jt]s|tsx)$/u, '')
}

function portablePath(path) {
  return path.replaceAll('\\', '/')
}
