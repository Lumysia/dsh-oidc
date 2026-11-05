import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  clean: true,
  dts: false,
  sourcemap: true,
  external: [/^@deepseek-ai\//u],
})
