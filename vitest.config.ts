import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The server plugin's suite lives here; the client plugin package
    // (packages/client/ui-dream-rsi) owns its own vitest config and aliases.
    include: ['tests/**/*.spec.ts'],
    exclude: ['**/node_modules/**', 'packages/**'],
  },
})
