import eslint from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-ts/**',
      '**/node_modules/**',
      // A stale node_modules backup accidentally placed at the repo root (not a workspace) —
      // ESLint's config search walks into it and trips over its vendored config stubs.
      'node_modules.bak/**',
      '.claude/worktrees/**',
      '.local-data/**',
      'logs/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.node,
    },
    rules: {
      // Several credential-handling paths deliberately clear local references in `finally`.
      'no-useless-assignment': 'off',
      // A leading underscore is the agreed marker for a parameter that exists only to satisfy a
      // callback signature (fetch mocks, event handlers) without being read in the body.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['apps/frontend/src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
);
