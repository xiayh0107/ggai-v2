import { build } from 'esbuild'

await build({
  entryPoints: ['cli/index.ts'],
  outfile: 'dist-cli/ggai.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: false,
})
