import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

// Correctness-focused ruleset for backend/**: catch bugs (undefined identifiers,
// dead code, unused vars) without imposing stylistic rules (quotes, semicolons,
// indentation). `no-undef` stays an error unconditionally — it's the rule that
// would have caught the ReferenceError this config was added to prevent.
const backendRules = {
  'no-undef': 'error',
  'no-unused-vars': [
    'warn',
    {
      args: 'none',
      caughtErrors: 'none',
      // Allow `const { omitMe, ...rest } = obj` (a common way to drop a key).
      ignoreRestSiblings: true,
    },
  ],
  // Empty `catch {}` blocks are a deliberate "ignore this failure" idiom used
  // throughout the backend (e.g. best-effort cleanup); don't flag those, but
  // still flag other empty blocks (likely dead/forgotten code).
  'no-empty': ['error', { allowEmptyCatch: true }],
}

export default defineConfig([
  globalIgnores([
    'dist/**',
    '.claude/**',
    'eur-lex-api/**',
    '**/*.html',
    '**/*_files/**',
    'backend/search/data/**',
    'backend/node_modules/**',
  ]),
  {
    files: ['src/**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs['recommended-latest'],
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],
    },
  },
  {
    files: ['extension/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.webextensions },
    },
  },
  {
    files: ['scripts/**/*.js', 'vite.config.js', 'eslint.config.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
  },
  {
    // Backend (Express API + `eurlex` CLI) is CommonJS unless it's a .mjs file (see below).
    files: ['backend/**/*.js'],
    ignores: ['backend/shared/formex-parser/fmxParser.test.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: backendRules,
  },
  {
    // This one backend test file is run by vitest (see vite.config.js `test.include`),
    // not `node --test`, and uses ESM import syntax like the frontend tests.
    files: ['backend/shared/formex-parser/fmxParser.test.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: backendRules,
  },
  {
    // backend/shared/formex-parser/*.mjs is ESM and also used directly by the frontend.
    // It runs in the browser DOM there, and against DOM globals shimmed onto `global`
    // by backend/shared/fmx-parser-node.js (via jsdom) when run under Node — so it
    // needs both Node and browser globals (DOMParser, Node, NodeFilter, etc.).
    files: ['backend/**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: backendRules,
  },
])
