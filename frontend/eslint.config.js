import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    // The service worker runs in a ServiceWorkerGlobalScope, not a window:
    // `self`, `caches` and `clients` are undefined under browser globals.
    files: ['public/sw.js'],
    languageOptions: { globals: globals.serviceworker },
  },
  {
    // Build tooling — runs in Node, not the browser.
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  {
    // Context modules export a provider component *and* its companion
    // hook (`useAuth`, `useToast`). react-refresh warns about mixed
    // exports because it can't hot-reload the file cleanly, but splitting
    // each hook into its own module to satisfy a dev-only ergonomic would
    // add indirection to every consumer. Scoped off here instead.
    files: ['src/context/*.jsx'],
    rules: { 'react-refresh/only-export-components': 'off' },
  },
])
