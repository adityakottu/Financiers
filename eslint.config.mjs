// Security lint gate (doc 11 §5). Deliberately narrow: each rule bans a pattern that leads to an
// injection, XSS or data-leak bug. Style is left to Prettier and TypeScript strict mode.
import nextPlugin from '@next/eslint-plugin-next';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

const restricted = [
  {
    selector: "CallExpression[callee.object.name='sql'][callee.property.name=/^(raw|lit)$/]",
    message: 'sql.raw / sql.lit put text straight into SQL. Use the sql`` template (parameters) or sql.ref for identifiers.',
  },
  {
    selector: "CallExpression[callee.property.name='query'] > TemplateLiteral[expressions.length>0]",
    message: 'Do not build SQL strings with ${}. Use query(text, [params]) or Kysely.',
  },
  {
    selector: "CallExpression[callee.property.name='query'] > BinaryExpression[operator='+']",
    message: 'Do not build SQL strings by concatenation. Use parameters.',
  },
  {
    selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
    message: 'No raw HTML in the UI: React escaping is our XSS defence.',
  },
];

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/coverage/**', '**/next-env.d.ts'] },
  {
    files: ['apps/*/src/**/*.{ts,tsx}', 'packages/*/src/**/*.ts'],
    languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { 'react-hooks': reactHooks, '@next/next': nextPlugin },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'react-hooks/rules-of-hooks': 'error',
      'no-restricted-syntax': ['error', ...restricted],
    },
  },
  {
    // Server code logs through the Nest logger (structured, redacted) — never console.
    files: ['apps/api/src/**/*.ts'],
    ignores: ['apps/api/src/db/**', 'apps/api/src/**/*.test.ts', 'apps/api/src/test/**'],
    rules: { 'no-console': 'error' },
  },
  {
    // Tests may set up roles with literal SQL.
    files: ['**/*.test.ts', 'apps/api/src/test/**'],
    rules: { 'no-restricted-syntax': ['error', ...restricted.slice(2)] },
  },
);
