'use strict';
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/**', 'data/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: { ...globals.node } },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_|^next$|^req$|^res$', caughtErrors: 'none', ignoreRestSiblings: true }],
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  {
    files: ['public/js/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser } },
    rules: { 'no-var': 'off', 'prefer-const': 'off' },
  },
  {
    // The live screens' browser code: ES modules (the .vue files are checked when the app compiles them).
    files: ['client/**/*.js'],
    languageOptions: { sourceType: 'module', globals: { ...globals.browser } },
  },
];
