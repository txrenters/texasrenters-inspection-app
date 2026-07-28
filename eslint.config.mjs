import eslint from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/.expo/**', '**/node_modules/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser, ...globals.jest },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: ['web-app/scripts/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    files: ['web-app/**/*.{ts,tsx}'],
    plugins: { '@next/next': nextPlugin },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
    },
  },
  {
    // Keeps the shadcn migration from regressing: the legacy CSS blocks these
    // names referred to have been deleted, so reintroducing one silently
    // produces an unstyled element rather than an error.
    files: ['web-app/app/**/*.tsx', 'web-app/components/**/*.tsx'],
    ignores: ['web-app/components/ui/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'JSXAttribute[name.name="className"] > Literal[value=/(^|\\s)(panel|panel-header|panel-description|field|field-error|field-help|field-grow|field-medium|field-compact|alert|alert-danger|alert-warning|alert-success|media-meta|section-kicker|detail-grid|detail-item|table-link|supporting-copy|floor-plan-muted)(\\s|$)/]',
          message:
            'Legacy UI class. Use the shadcn primitives in components/ui (Card, Field, Alert, Table…) or Tailwind tokens instead.',
        },
        {
          selector: 'JSXOpeningElement[name.name=/^(table|thead|tbody|tfoot)$/]',
          message: 'Use the Table primitives from @/components/ui/table.',
        },
        {
          selector: 'JSXOpeningElement[name.name="dialog"]',
          message: 'Use Dialog, AlertDialog or Sheet from @/components/ui.',
        },
        {
          // Native modals ignore the design system and block the event loop, so
          // deferred AlertDialog flows cannot be built on them.
          selector:
            'CallExpression[callee.object.name="window"][callee.property.name=/^(confirm|alert)$/]',
          message: 'Use AlertDialog from @/components/ui/alert-dialog.',
        },
        {
          selector: 'JSXOpeningElement[name.name="select"]',
          message: 'Use Select from @/components/ui/select (or SearchableSelect when the list needs search).',
        },
        {
          // Native controls keep OS chrome here because Preflight is not loaded.
          selector:
            'JSXOpeningElement[name.name="input"]:has(JSXAttribute[name.name="type"][value.value="checkbox"])',
          message: 'Use Checkbox from @/components/ui/checkbox.',
        },
      ],
    },
  },
  {
    // The primitives themselves are the one place these tags are legitimate.
    files: ['web-app/components/ui/**/*.tsx'],
    rules: { 'no-restricted-syntax': 'off' },
  },
);
