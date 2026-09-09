// @ts-check
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';
import headersPlugin from 'eslint-plugin-headers';
import neverthrowPlugin from '@ninoseki/eslint-plugin-neverthrow';
import simpleImportSort from 'eslint-plugin-simple-import-sort';

const NO_DIRECT_FETCH_MESSAGE =
  "Don't call fetch() directly — use fetchAuthenticated() (credentialed requests) or " +
  'fetchAnonymous() (credential-free requests) from @/core/server/fetch.ts, ' +
  'so proxy and TLS configuration are always applied.';

export default tseslint.config(
  // Global ignores
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },

  // License header enforcement
  {
    files: ['src/**/*.ts'],
    plugins: { headers: headersPlugin },
    rules: {
      'headers/header-format': ['error', {
        source: 'file',
        path: 'LICENSE',
        blockPrefix: '\n'
      }],
    },
  },
  // Base TypeScript config for source files
  {
    files: ['src/**/*.ts'],
    extends: [
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    plugins: {
      'simple-import-sort': simpleImportSort,
    },
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
      // TypeScript-specific overrides
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports', fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/consistent-type-definitions': 'off',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/prefer-nullish-coalescing': 'off',
      '@typescript-eslint/array-type': 'off',
      // Allow numbers and booleans in template literals — very common in CLI output
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true, allowBoolean: true }],
      // Downgrade unsafe rules to warn — CLI code often interacts with loosely typed APIs
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-confusing-void-expression': 'warn',

      // General best practices
      'no-console': 'warn',
    },
  },

  // CLI-1086 note: catch a Result built (via a domain client, errAsync(), etc.) but never
  // consumed — not mapped, chained, matched, or collapsed. `eslint-plugin-neverthrow` (the
  // package usually recommended for this) hasn't published since 2021 and hard-crashes on
  // this repo's ESLint 10 + typescript-eslint 8 (it reads context.parserServices, an API
  // removed since); this fork (https://github.com/ninoseki/eslint-plugin-neverthrow) is the
  // same rule kept working for current ESLint. Scoped to the files this spike PR actually
  // converted rather than every `src/**/*.ts` file: a repo-wide rollout surfaces ~17
  // pre-existing unconsumed Results in files this PR doesn't touch (CLI-844's own
  // conversion), which is its own follow-up once more commands migrate under CLI-1086.
  {
    files: ['src/core/result.ts', 'src/core/commands/sonar-command.ts', 'src/commands/list/projects.ts'],
    plugins: { neverthrow: neverthrowPlugin },
    rules: {
      'neverthrow/must-use-result': 'error',
    },
  },

  // Telemetry/Sentry destinations are reachable only from the two modules that own the
  // outbound call, and `neverthrow` is reachable only from the one module that patches its
  // prototype with `orThrow()` as a side effect of being loaded; the owners are exempted
  // in the blocks that follow. Two separate `no-restricted-imports` config objects on the
  // same files would silently overwrite each other in flat config, so both restrictions
  // for `src/**/*.ts` are combined into this one block.
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'neverthrow',
              message: "Import from '@/core/result.ts' instead, so orThrow() is always loaded.",
            },
          ],
          // Matched as a glob against the import string, so every spelling of the path is
          // covered — alias, ./, ../ and deeper.
          patterns: [
            {
              group: ['**/config-constants.ts'],
              importNames: ['TELEMETRY_ENDPOINT', 'TELEMETRY_API_KEY', 'SENTRY_DSN'],
              message:
                'Telemetry/Sentry destinations are confined to src/core/telemetry/telemetry-events.ts and src/core/observability/sentry.ts. Gate new outbound calls on resolveTelemetryEgress() instead.',
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      'src/core/telemetry/telemetry-events.ts',
      'src/core/observability/sentry.ts',
      'src/core/result.ts',
    ],
    rules: {
      'no-restricted-imports': 'off',
    },
  },

  // Tests don't need the telemetry restriction (they legitimately mock those constants),
  // but should still be routed through result.ts rather than importing neverthrow raw.
  {
    files: ['tests/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'neverthrow',
              message: "Import from '@/core/result.ts' instead, so orThrow() is always loaded.",
            },
          ],
        },
      ],
    },
  },

  // Every outbound HTTP request must carry the resolved proxy/TLS configuration, so the
  // runtime fetch is reachable only from the module that owns the wrappers (exempted below).
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        // Bare `fetch(...)`, then every qualified form (globalThis.fetch, Bun.fetch, ...).
        { selector: "CallExpression[callee.name='fetch']", message: NO_DIRECT_FETCH_MESSAGE },
        {
          selector: "CallExpression[callee.type='MemberExpression'][callee.property.name='fetch']",
          message: NO_DIRECT_FETCH_MESSAGE,
        },
      ],
    },
  },
  {
    files: ['src/core/server/fetch.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },

  // Relaxed rules for non-shipped code (tests + build scripts)
  {
    files: ['tests/**/*.ts', 'build-scripts/**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    plugins: {
      'simple-import-sort': simpleImportSort,
    },
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off',
    },
  },

  // Prettier must be last — disables all formatting rules
  prettierConfig,
);
