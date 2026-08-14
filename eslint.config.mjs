// The engine's own linter. It replaces shell-lint.mjs's job here: once every
// hook and script is .mjs, there is no .sh left for shellcheck to check, and
// "nothing checks the checker" is exactly the gap that motivated shell-lint
// in the first place.
//
// Deliberately minimal: this repo's own value is a language-agnostic engine,
// so it carries no framework-specific rules (no NestJS boundary rules, no
// hexagonal-layer plugin) — those belong to a consuming repo's OWN
// eslint.config, per no-repo-refs.mjs. This config catches what a plain
// Node/ESM script can get wrong: unused vars, undefined globals, obvious
// correctness slips. Type-shape checking is tsc's job (see tsconfig.json,
// `checkJs`), not this file's.
export default [
  {
    files: ['hooks/**/*.mjs', 'scripts/**/*.mjs', 'bin/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-const-assign': 'error',
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
      eqeqeq: ['warn', 'smart'],
    },
  },
];
