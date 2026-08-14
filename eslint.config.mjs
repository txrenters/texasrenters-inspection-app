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
    files: ['web/scripts/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    files: ['web/**/*.{ts,tsx}'],
    plugins: { '@next/next': nextPlugin },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
    },
  },
  {
    /**
     * web ships no bespoke CSS — `app/globals.css` is tokens only, and every
     * legacy class name it could refer to was deliberately not carried over. A
     * `className` holding a raw colour is the way that erodes: it works, it
     * looks local, and it silently opts that element out of theming, so it is
     * the one thing worth failing the build over.
     */
    files: ['web/app/**/*.tsx', 'web/components/**/*.tsx'],
    ignores: ['web/components/ui/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          // Descendant, not direct child: `className={cn('…')}` and
          // `className={ok ? 'a' : 'b'}` put the string inside an expression, and
          // a `>` combinator sees neither. That is how `text-emerald-600` reached
          // the homeowner report while this rule was notionally on.
          selector:
            'JSXAttribute[name.name="className"] Literal[value=/(^|[\\s:[])(#[0-9a-fA-F]{3,8}\\b|rgba?\\(|hsla?\\()/]',
          message:
            'Raw colour in a className. Use a theme token (bg-card, text-muted-foreground, border-border…) so the element follows light and dark mode.',
        },
        {
          // The other half of the same hole. In a token-only Tailwind v4 app the
          // realistic erosion is not `#85c43f`, it is `text-emerald-600` — a
          // palette utility that renders correctly, reviews cleanly, and is the
          // one element on the page that ignores the theme.
          selector:
            'JSXAttribute[name.name="className"] Literal[value=/(^|[\\s:[])(text|bg|border|ring|divide|outline|fill|stroke|from|via|to|shadow|accent|caret|decoration)-(red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\\d{2,3}\\b/]',
          message:
            'Tailwind palette colour in a className. Use a theme token (text-success, text-destructive, text-muted-foreground, bg-card…) so the element follows light and dark mode.',
        },
        {
          // `text-white` on a status fill. The palette rule above misses this
          // because "white" carries no numeric scale, and it is the exact shape
          // of a real bug: the inspection stepper drew its tick in white on
          // `bg-success`, which is a mid-green in light mode (6.2:1, fine) and a
          // light green in dark mode (1.95:1, invisible). Use `text-background`,
          // which is the most contrasting neutral in whichever mode is active.
          //
          // Scoped to *tinted fills* on purpose. Plain `text-white` over video,
          // a lightbox or a `bg-black/50` scrim is correct and mode-independent,
          // and flagging those would mean fifteen disable comments.
          selector:
            'JSXAttribute[name.name="className"] Literal[value=/(bg-(success|destructive|warning|primary|info|brand)\\b[^"]*\\btext-(white|black)\\b|text-(white|black)\\b[^"]*\\bbg-(success|destructive|warning|primary|info|brand)\\b)/]',
          message:
            'Hardcoded white/black on a themed fill. These fills invert between light and dark, so use text-background (or the token\'s own -foreground) instead.',
        },
        {
          selector: 'JSXOpeningElement[name.name=/^(table|thead|tbody|tfoot)$/]',
          message: 'Use the Table primitives from @/components/ui/table, or the DataTable component.',
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
          message:
            'Use Select from @/components/ui/select (or SearchableSelect when the list needs search).',
        },
        {
          selector:
            'JSXOpeningElement[name.name="input"]:has(JSXAttribute[name.name="type"][value.value="checkbox"])',
          message: 'Use Checkbox from @/components/ui/checkbox.',
        },
      ],
    },
  },
  {
    // The primitives themselves are the one place these tags are legitimate.
    files: ['web/components/ui/**/*.tsx'],
    rules: { 'no-restricted-syntax': 'off' },
  },
);
