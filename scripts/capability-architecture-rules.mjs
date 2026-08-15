import { posix } from 'node:path'

export const CAPABILITY_BOUNDARY_GROUP_COUNT = 6

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
  'daemon/serverLegacy',
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
const CAPABILITY_COMPOSITION_ROOTS = new Set([
  'daemon/agentRuntime.ts',
  'daemon/application.ts',
])
const PLUGIN_HOST_MODULE = 'daemon/runtime/pluginHost'

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
  if (path.startsWith('daemon/http/')) {
    violations.push(...httpAdapterViolations(path, imports))
  }
  violations.push(...compositionOwnershipViolations(path, imports))
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

function httpAdapterViolations(sourcePath, imports) {
  const violations = []
  for (const specifier of imports) {
    if (specifier.startsWith('@/') || UI_PACKAGES.test(specifier)) {
      violations.push(`${sourcePath} imports browser/UI module ${specifier}`)
    }
    const resolved = resolvedProjectModule(sourcePath, specifier)
    if (!resolved) continue
    const stem = stripModuleExtension(resolved)
    if (stem === PLUGIN_HOST_MODULE || stem.startsWith('daemon/plugins/')) {
      violations.push(`${sourcePath} imports runtime composition implementation ${specifier}`)
    }
  }
  return violations
}

function compositionOwnershipViolations(sourcePath, imports) {
  if (/\.test\.[cm]?[jt]sx?$/u.test(sourcePath)
    || sourcePath.startsWith('daemon/__tests__/')) return []
  const violations = []
  for (const specifier of imports) {
    const resolved = resolvedProjectModule(sourcePath, specifier)
    if (!resolved) continue
    const stem = stripModuleExtension(resolved)
    if (stem.startsWith('daemon/plugins/') && !CAPABILITY_COMPOSITION_ROOTS.has(sourcePath)) {
      violations.push(
        `${sourcePath} imports runtime plugin ${specifier}; only composition roots may mount plugins`,
      )
    }
    if (
      stem === PLUGIN_HOST_MODULE
      && !sourcePath.startsWith('daemon/runtime/')
      && !sourcePath.startsWith('daemon/plugins/')
      && !CAPABILITY_COMPOSITION_ROOTS.has(sourcePath)
      && sourcePath !== 'daemon/capabilityScopes.ts'
    ) {
      violations.push(
        `${sourcePath} imports PluginHost; kernel consumers must depend on capability services`,
      )
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
