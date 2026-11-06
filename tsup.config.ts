import { defineConfig } from 'tsup'
import { readFileSync } from 'node:fs'

const { name } = JSON.parse(readFileSync('package.json', 'utf8')) as { name: string }

/** Modules the DSH page shares with every client plugin (its frozen platform table). */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'node24',
    clean: true,
    dts: false,
    sourcemap: true,
    external: [/^@deepseek-ai\//u],
  },
  {
    // DSH's client module format: one script that registers a lazy CommonJS
    // factory with the page's module loader, resolving shared modules through
    // the injected `require` (packages/client/modules, "Lazy-CJS model").
    entry: { client: 'src/client/index.ts' },
    format: ['cjs'],
    platform: 'browser',
    target: 'es2023',
    outExtension: () => ({ js: '.js' }),
    clean: false,
    dts: false,
    sourcemap: false,
    minify: false,
    external: PLATFORM_MODULES,
    noExternal: [/^(?!react$|react\/|react-dom|@deepseek-ai\/)/u],
    esbuildOptions(options) {
      options.jsx = 'automatic'
      options.define = { ...options.define, 'process.env.NODE_ENV': '"production"' }
    },
    banner: {
      js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(name)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;`,
    },
    footer: { js: 'return module.exports; } });' },
  },
])
