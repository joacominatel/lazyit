// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Machine-generated and compiled output is never hand-authored: the Prisma client
    // (`prisma generate` → generated/prisma) and the Nest build (`dist`). Linting it floods
    // the report with thousands of false positives on a clean checkout — exclude both so
    // `eslint .` reports only authored source. The `.cjs` test helper is a CommonJS child
    // process deliberately outside the TS project, so the type-checked parser can't read it.
    ignores: ['eslint.config.mjs', 'generated/**', 'dist/**', '**/*.cjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      "prettier/prettier": ["error", { endOfLine: "auto" }],
    },
  },
);
