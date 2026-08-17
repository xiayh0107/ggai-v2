import { readFile } from 'node:fs/promises'
import process from 'node:process'
import {
  APPROVED_LICENSES,
  OFFICIAL_REGISTRY_HOST,
} from './dependency-policy.mjs'

const ROOT_PACKAGE = ''
const EXPECTED_NODE_RANGE = '>=24.19.0 <25'
const EXPECTED_NPM_RANGE = '>=10.9.0 <12'

const errors = []
const notices = []

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))
const [manifest, lockfile, nvmVersion, npmrc] = await Promise.all([
  readJson(new URL('../package.json', import.meta.url)),
  readJson(new URL('../package-lock.json', import.meta.url)),
  readFile(new URL('../.nvmrc', import.meta.url), 'utf8').then((value) => value.trim()),
  readFile(new URL('../.npmrc', import.meta.url), 'utf8'),
])

function fail(message) {
  errors.push(message)
}

function notice(message) {
  notices.push(message)
}

function entries(section) {
  return Object.entries(manifest[section] ?? {})
}

function equalRecords(left, right) {
  const leftEntries = Object.entries(left ?? {}).sort(([a], [b]) => a.localeCompare(b))
  const rightEntries = Object.entries(right ?? {}).sort(([a], [b]) => a.localeCompare(b))
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries)
}

function supportsNode(version) {
  const [major, minor] = version.split('.').map(Number)
  return (major === 22 && minor >= 22) || major === 24
}

function supportsNpm(version) {
  const [major, minor] = version.split('.').map(Number)
  return (major === 10 && minor >= 9) || major === 11
}

if (!supportsNode(process.versions.node)) {
  notice(`Node.js ${process.versions.node} is outside the required Node 24.19+ range`)
}

const npmUserAgent = process.env.npm_config_user_agent ?? ''
const npmVersion = npmUserAgent.match(/(?:^|\s)npm\/([^\s]+)/)?.[1]
if (npmVersion && !supportsNpm(npmVersion)) {
  notice(`npm ${npmVersion} is outside the recommended npm 10.9+/11 range`)
}

if (nvmVersion !== '24.19.0') {
  notice(`.nvmrc differs from the required 24.19.0 baseline: ${nvmVersion || '(empty)'}`)
}

if (manifest.packageManager !== 'npm@10.9.8') {
  notice(`packageManager differs from the recommended npm@10.9.8 baseline`)
}

if (manifest.engines?.node !== EXPECTED_NODE_RANGE || manifest.engines?.npm !== EXPECTED_NPM_RANGE) {
  notice('package.json engines differ from the recommended Node/npm ranges')
}
if (
  manifest.devEngines?.runtime?.version !== EXPECTED_NODE_RANGE
  || manifest.devEngines?.runtime?.onFail !== 'warn'
  || manifest.devEngines?.packageManager?.version !== EXPECTED_NPM_RANGE
  || manifest.devEngines?.packageManager?.onFail !== 'warn'
) {
  notice('package.json devEngines differ from the recommended advisory ranges')
}

const npmConfig = new Map(npmrc
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'))
  .map((line) => {
    const separator = line.indexOf('=')
    return separator < 0 ? [line, ''] : [line.slice(0, separator), line.slice(separator + 1)]
  }))
for (const [key, value] of Object.entries({
  'engine-strict': 'false',
  'ignore-scripts': 'false',
  'package-lock': 'true',
  'save-exact': 'true',
})) {
  if (npmConfig.get(key) !== value) fail(`.npmrc must set ${key}=${value}`)
}

if (lockfile.lockfileVersion !== 3) {
  fail(`package-lock.json must use lockfileVersion 3, found ${lockfile.lockfileVersion}`)
}

const root = lockfile.packages?.[ROOT_PACKAGE]
if (!root) {
  fail('package-lock.json is missing its root package entry')
} else {
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const expected = Object.fromEntries(entries(section))
    const actual = root[section] ?? {}
    if (!equalRecords(expected, actual)) {
      fail(`package.json and package-lock.json disagree in ${section}; run npm install`)
    }
  }
}

const ownership = new Map()
const rangedDirectDependencies = []
for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
  for (const [name] of entries(section)) {
    if (ownership.has(name)) {
      fail(`${name} is declared in both ${ownership.get(name)} and ${section}`)
    }
    ownership.set(name, section)

    const declaredVersion = manifest[section][name]
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(declaredVersion)) {
      rangedDirectDependencies.push(`${name}@${declaredVersion}`)
    }

    if (!lockfile.packages?.[`node_modules/${name}`]) {
      fail(`${name} is declared in ${section} but missing from package-lock.json`)
    }
  }
}

let registryPackages = 0
let integrityPackages = 0
const installScripts = []
const licenses = new Set()
const unreviewedLicenses = []
const alternateSources = []
const missingIntegrity = []

for (const [path, pkg] of Object.entries(lockfile.packages ?? {})) {
  if (!path) continue

  if (typeof pkg.license !== 'string') {
    unreviewedLicenses.push(`${path}: missing`)
  } else if (!APPROVED_LICENSES.has(pkg.license)) {
    unreviewedLicenses.push(`${path}: ${pkg.license}`)
  } else {
    licenses.add(pkg.license)
  }

  if (pkg.resolved) {
    let url
    try {
      url = new URL(pkg.resolved)
    } catch {
      alternateSources.push(`${path}: ${pkg.resolved}`)
    }

    if (url && (url.protocol !== 'https:' || url.hostname !== OFFICIAL_REGISTRY_HOST)) {
      alternateSources.push(`${path}: ${pkg.resolved}`)
    } else if (url) {
      registryPackages += 1
    }

    if (!pkg.integrity) {
      missingIntegrity.push(path)
    } else {
      integrityPackages += 1
    }
  }

  if (pkg.hasInstallScript) {
    installScripts.push(path)
  }
}

if (errors.length > 0) {
  console.error('Dependency policy check failed:')
  for (const error of errors) console.error(`- ${error}`)
  process.exitCode = 1
} else {
  console.log(`Dependency structure OK: ${ownership.size} direct, ${registryPackages} npm registry packages`)
  console.log(`Integrity hashes: ${integrityPackages}; lifecycle-script packages: ${installScripts.join(', ') || 'none'}`)
  console.log(`Reviewed licenses: ${[...licenses].sort().join(', ')}`)
  if (rangedDirectDependencies.length > 0) {
    console.log(`Version ranges (allowed): ${rangedDirectDependencies.join(', ')}`)
  }
  if (unreviewedLicenses.length > 0) {
    console.log(`Unreviewed license metadata (allowed): ${unreviewedLicenses.join(', ')}`)
  }
  if (alternateSources.length > 0) {
    console.log(`Alternate dependency sources (allowed): ${alternateSources.join(', ')}`)
  }
  if (missingIntegrity.length > 0) {
    console.log(`Packages without integrity metadata (allowed): ${missingIntegrity.join(', ')}`)
  }
  for (const message of notices) console.log(`Notice: ${message}`)
}
