import { build } from 'esbuild'

await build({
  entryPoints: ['cli/index.ts'],
  outfile: 'dist-cli/ggai.js',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: false,
})
