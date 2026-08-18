import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const distRoot = path.join(appRoot, 'dist-daemon')
const releaseRoot = path.join(appRoot, 'release', 'daemon')

const [rootManifest, rootLockfile] = await Promise.all([
  readFile(path.join(appRoot, 'package.json'), 'utf8').then(JSON.parse),
  readFile(path.join(appRoot, 'package-lock.json'), 'utf8').then(JSON.parse),
])

const runtimeDependencyNames = ['ajv', 'chokidar', 'sharp']
const runtimeDependencies = Object.fromEntries(runtimeDependencyNames.map((name) => {
  const version = rootLockfile.packages?.[`node_modules/${name}`]?.version
  if (typeof version !== 'string') throw new Error(`The root lockfile does not contain ${name}`)
  if (rootManifest.dependencies?.[name] !== version) {
    throw new Error(`The root manifest and lockfile disagree on the ${name} version`)
  }
  return [name, version]
}))

await rm(releaseRoot, { recursive: true, force: true })
await mkdir(path.dirname(releaseRoot), { recursive: true })
await cp(distRoot, releaseRoot, { recursive: true })

const runtimeManifest = {
  name: '@ggai/daemon-runtime',
  version: rootManifest.version,
  private: true,
  description: 'Minimal runtime package for the GGAI local daemon',
  license: 'UNLICENSED',
  type: 'module',
  engines: rootManifest.engines,
  bin: {
    'ggai-daemon': 'daemon/index.js',
  },
  scripts: {
    start: 'node daemon/index.js',
  },
  dependencies: {
    ...runtimeDependencies,
  },
}

const runtimeLockfile = projectRuntimeLockfile(rootLockfile, runtimeManifest)
assertProjectedRoot(runtimeLockfile, runtimeManifest)

await Promise.all([
  writeFile(
    path.join(releaseRoot, 'package.json'),
    `${JSON.stringify(runtimeManifest, null, 2)}\n`,
    'utf8',
  ),
  writeFile(
    path.join(releaseRoot, 'package-lock.json'),
    `${JSON.stringify(runtimeLockfile, null, 2)}\n`,
    'utf8',
  ),
  writeFile(
    path.join(releaseRoot, '.npmrc'),
    [
      'engine-strict=false',
      'ignore-scripts=false',
      'package-lock=true',
      'save-exact=true',
      'audit=true',
      'fund=false',
      '',
    ].join('\n'),
    'utf8',
  ),
  writeFile(
    path.join(releaseRoot, 'README.md'),
    [
      '# GGAI daemon runtime',
      '',
      'Install with `npm ci --omit=dev`, then run `npm start -- --project-root /path/to/project`.',
      'Codex and acpx remain user-level CLI dependencies. Codex is discovered from PATH; acpx adapters require an explicit --acpx-agent opt-in.',
      '',
    ].join('\n'),
    'utf8',
  ),
])

console.log(`Daemon runtime prepared at ${releaseRoot}`)
console.log(`Runtime npm dependencies: ${Object.entries(runtimeDependencies)
  .map(([name, version]) => `${name}@${version}`).join(', ')}`)
console.log(`Runtime lock projection: ${Object.keys(runtimeLockfile.packages).length - 1} packages`)

function projectRuntimeLockfile(root, manifest) {
  const rootPackages = root.packages ?? {}
  const selected = new Map()
  const queue = Object.keys(manifest.dependencies).map((name) => {
    const lockedPath = resolveLockedDependency(rootPackages, '', name)
    if (!lockedPath) throw new Error(`The root lockfile does not contain runtime dependency ${name}`)
    return lockedPath
  })

  while (queue.length > 0) {
    const packagePath = queue.shift()
    if (!packagePath || selected.has(packagePath)) continue
    const lockedPackage = rootPackages[packagePath]
    if (!lockedPackage) throw new Error(`Missing locked runtime package ${packagePath}`)
    const projectedPackage = structuredClone(lockedPackage)
    delete projectedPackage.dev
    delete projectedPackage.devOptional
    selected.set(packagePath, projectedPackage)

    for (const name of Object.keys(lockedPackage.dependencies ?? {})) {
      const dependencyPath = resolveLockedDependency(rootPackages, packagePath, name)
      if (!dependencyPath) {
        throw new Error(`${packagePath} depends on missing locked package ${name}`)
      }
      queue.push(dependencyPath)
    }
    for (const name of Object.keys(lockedPackage.optionalDependencies ?? {})) {
      const dependencyPath = resolveLockedDependency(rootPackages, packagePath, name)
      if (dependencyPath) queue.push(dependencyPath)
    }
  }

  const packages = Object.fromEntries([...selected.entries()].sort(([left], [right]) =>
    left.localeCompare(right)))
  return {
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: manifest.name,
        version: manifest.version,
        license: manifest.license,
        dependencies: manifest.dependencies,
        bin: manifest.bin,
        engines: manifest.engines,
      },
      ...packages,
    },
  }
}

function assertProjectedRoot(lockfile, manifest) {
  const root = lockfile.packages?.['']
  for (const field of ['name', 'version', 'license', 'bin', 'dependencies', 'engines']) {
    if (JSON.stringify(root?.[field]) !== JSON.stringify(manifest[field])) {
      throw new Error(`The runtime lockfile root does not match package.json field ${field}`)
    }
  }
}

function resolveLockedDependency(packages, parentPackagePath, dependencyName) {
  let scope = parentPackagePath
  while (true) {
    const candidate = scope
      ? `${scope}/node_modules/${dependencyName}`
      : `node_modules/${dependencyName}`
    if (packages[candidate]) return candidate
    if (!scope) return undefined
    const marker = scope.lastIndexOf('/node_modules/')
    scope = marker >= 0 ? scope.slice(0, marker) : ''
  }
}
