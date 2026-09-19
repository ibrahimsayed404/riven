// ESLint for @riven/api (fix.js CI-01 / recommend.js FOUND-01).
//
// Two jobs: the usual correctness rules, and the repository's architecture
// rules encoded so they fail the build instead of relying on review:
//   - Prisma is only touched from *.repository.ts (and infra/).
//   - No module imports another module's repository class.
//   - No console.*; use Nest's Logger.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const ARCHITECTURE_RULES = {
  'no-console': 'error',
  'no-restricted-imports': [
    'error',
    {
      patterns: [
        {
          group: ['**/infra/prisma/prisma.service', '**/infra/prisma/prisma.service.js'],
          message: 'PrismaService is injected only in *.repository.ts (CLAUDE.md: every Prisma call lives in the repository).',
        },
        {
          group: ['../*/*.repository', '../*/**/*.repository', '../../modules/*/*.repository'],
          message: "Never import another module's repository — go through its exported service (CLAUDE.md).",
        },
      ],
    },
  ],
};

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'scripts/**', 'eslint.config.mjs'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'prisma/**/*.ts'],
    languageOptions: {
      parserOptions: {
        // prisma/seed.ts is compiled by its own tsconfig (CI typecheck wires it the same way).
        projectService: { allowDefaultProject: ["prisma/seed.ts"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      ...ARCHITECTURE_RULES,
      // Existing code leans on `any` in tests and Prisma glue; surface, don't block.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // The places that are allowed to hold a PrismaService.
    files: ['src/**/*.repository.ts', 'src/infra/**/*.ts', 'src/**/*.spec.ts', 'prisma/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    // Seed and one-off scripts talk to the console on purpose.
    files: ['prisma/seed.ts'],
    rules: { 'no-console': 'off' },
  },
);
