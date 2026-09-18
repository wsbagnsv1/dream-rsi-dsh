/**
 * Dream-RSI web UI client plugin build.
 *
 * Two artifacts:
 * - `lib/index.js`  — the Node (host) half: a plain ESM bundle, imported by the
 *   cordis Loader for the composition row (the plugin body is a no-op).
 * - `lib/client.js` — the browser half, in the DSH client-module closure-factory
 *   format the ClientModuleRegistry serves at /plugins/<pkg>/client.js and the
 *   browser registers through `window.__ModuleLoader__.load({id, factory})`.
 *   Platform modules (react, the shared DSH client libraries) stay external:
 *   their `require()` resolves through the browser module table.
 */
import { readFileSync } from 'node:fs'
import { build } from 'esbuild'

const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const name = manifest.name

/** Everything a client bundle requires resolves through the browser module table. */
const clientExternals = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/*',
]

/** Host-half externals: nothing — the no-op body imports nothing. */
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  bundle: true,
  sourcemap: false,
  logLevel: 'info',
})

await build({
  entryPoints: ['src/client/index.ts'],
  outfile: 'lib/client.js',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  bundle: true,
  sourcemap: true,
  sourcesContent: true,
  jsx: 'automatic',
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  external: clientExternals,
  banner: {
    // esbuild has no `intro` option: the module-system bookkeeping rides the
    // banner ahead of the bundled body.
    js: [
      'var module = { exports: {} }; var exports = module.exports;',
      `window.__ModuleLoader__.load({ id: ${JSON.stringify(name)}, factory: (require) => {`,
    ].join('\n'),
  },
  footer: {
    js: 'return module.exports; } });',
  },
})
