// ESLint flat config (T-0001). Includes the money-number ban from the constitution (art. 3):
// amounts are `Money { minor: bigint; currency }`, never `number`.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const MONEY_TOKENS = new Set(['amount', 'minor', 'price', 'cost', 'balance', 'fee', 'fees', 'markup', 'money', 'cents', 'agorot']);
/**
 * True when any camelCase / snake_case token of the name is a money word (so `UNBALANCED` is not).
 * Basis points (`markupBps`, `fx_markup_bps`) and counts (`feeCount`) are integers, not money.
 */
const looksLikeMoney = (name) => {
  const tokens = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .map((t) => t.toLowerCase());
  if (tokens.includes('bps') || tokens.includes('count') || tokens.includes('pct') || tokens.includes('percent')) return false;
  return tokens.some((t) => MONEY_TOKENS.has(t));
};

/** Local rule: no `number` where money lives. */
const noMoneyNumber = {
  meta: {
    type: 'problem',
    docs: { description: 'Money is bigint minor units + currency; never `number` (constitution art. 3)' },
    messages: {
      numberType: '`{{name}}` looks like money; type it as `bigint` or `Money`, not `number`.',
      numberLiteral: '`money()` takes bigint minor units (write `{{value}}n`).',
      numberValue: '`{{name}}` looks like money; use a bigint literal (`{{value}}n`).',
    },
    schema: [],
  },
  create(context) {
    const nameOf = (node) => {
      if (!node) return undefined;
      if (node.type === 'Identifier') return node.name;
      if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
      return undefined;
    };
    const checkAnnotation = (name, typeAnnotation) => {
      if (!name || !looksLikeMoney(name) || !typeAnnotation) return;
      const t = typeAnnotation.typeAnnotation;
      if (t?.type === 'TSNumberKeyword') context.report({ node: t, messageId: 'numberType', data: { name } });
    };
    return {
      Identifier(node) {
        if (node.typeAnnotation) checkAnnotation(node.name, node.typeAnnotation);
      },
      TSPropertySignature(node) {
        checkAnnotation(nameOf(node.key), node.typeAnnotation);
      },
      PropertyDefinition(node) {
        checkAnnotation(nameOf(node.key), node.typeAnnotation);
      },
      CallExpression(node) {
        if (node.callee.type !== 'Identifier' || node.callee.name !== 'money') return;
        const [first] = node.arguments;
        if (first?.type === 'Literal' && typeof first.value === 'number') {
          context.report({ node: first, messageId: 'numberLiteral', data: { value: String(first.value) } });
        }
      },
      Property(node) {
        const name = nameOf(node.key);
        if (!name || !looksLikeMoney(name)) return;
        if (node.value.type === 'Literal' && typeof node.value.value === 'number') {
          context.report({ node: node.value, messageId: 'numberValue', data: { name, value: String(node.value.value) } });
        }
      },
    };
  },
};

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/.turbo/**', '**/.next/**', '.claude/**', 'pnpm-lock.yaml', '**/*.generated.ts'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { globals: { console: 'readonly', process: 'readonly', URL: 'readonly', Buffer: 'readonly', fetch: 'readonly' } },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { kesher: { rules: { 'no-money-number': noMoneyNumber } } },
    rules: {
      'kesher/no-money-number': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      // Fallback secrets are banned (Tab 3 §8): `process.env.X ?? 'default'` is caught by this pattern.
      'no-restricted-syntax': [
        'error',
        {
          selector: "LogicalExpression[operator='??'][left.object.object.name='process'][left.object.property.name='env']",
          message: 'No fallback for environment variables; read config through the Zod loader (constitution art. 6).',
        },
        {
          selector: "LogicalExpression[operator='||'][left.object.object.name='process'][left.object.property.name='env']",
          message: 'No fallback for environment variables; read config through the Zod loader (constitution art. 6).',
        },
      ],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.prop.test.ts', '**/*.contract.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
);
