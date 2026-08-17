import { rm } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ALLOWED_OUTPUTS = new Set(['dist-cli', 'dist-daemon', 'dist-daemon-test'])
const outputName = process.argv[2]

if (!outputName || !ALLOWED_OUTPUTS.has(outputName)) {
  console.error(`Expected one of: ${[...ALLOWED_OUTPUTS].join(', ')}`)
  process.exit(2)
}

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const outputPath = path.join(appRoot, outputName)
await rm(outputPath, { recursive: true, force: true })
