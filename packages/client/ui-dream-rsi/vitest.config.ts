import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: [
      // The package typechecks against the ambient mirror in
      // src/client/dsh-ambient.d.ts; the runtime value import resolves through
      // the browser module table. Tests get this minimal faithful stub.
      // fileURLToPath (not url.pathname): the path must stay a valid Windows path.
      {
        find: '@deepseek-ai/dsh-client-store',
        replacement: fileURLToPath(new URL('./tests/stubs/dsh-client-store.ts', import.meta.url)),
      },
    ],
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    exclude: ['**/node_modules/**'],
  },
})
