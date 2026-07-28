import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tailwindcss from '@tailwindcss/postcss';
import postcss from 'postcss';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Compiles the real Tailwind entry so the migration foundation is verified
 * rather than assumed: utilities must be generated, the brand palette must
 * reach shadcn's token names, dark mode must follow the existing data-theme
 * toggle, and preflight must stay out until the legacy stylesheet is gone.
 */
async function buildCss(markup: string) {
  const dir = mkdtempSync(join(tmpdir(), 'tw-'));
  const page = join(dir, 'page.tsx');
  writeFileSync(page, markup);
  const entry = join(dir, 'entry.css');
  const source =
    `@import '${join(process.cwd(), 'app/tailwind.css').replaceAll('\\', '/')}';\n` +
    // Scan the throwaway file only, so the assertions describe this markup.
    `@source '${page.replaceAll('\\', '/')}';\n`;
  writeFileSync(entry, source);
  const result = await postcss([tailwindcss()]).process(source, { from: entry });
  return result.css;
}

describe('tailwind + shadcn foundation', () => {
  let css = '';
  beforeAll(async () => {
    css = await buildCss(
      `export default () => <div className="bg-primary text-muted-foreground rounded-lg dark:bg-card border p-4" />;`,
    );
  }, 60_000);

  it('generates utilities for the classes it finds', () => {
    expect(css).toMatch(/\.bg-primary/);
    expect(css).toMatch(/\.rounded-lg/);
    expect(css).toMatch(/\.p-4/);
  });

  it('maps shadcn tokens onto the existing brand variables', () => {
    // --color-primary resolves through --blue rather than shadcn's default
    // neutral scale, so migrated components match unmigrated screens.
    expect(css).toMatch(/--color-primary:\s*var\(--blue\)/);
    expect(css).toMatch(/--color-destructive:\s*var\(--danger\)/);
    expect(css).toMatch(/--color-muted-foreground:\s*var\(--text-2\)/);
  });

  it('drives dark mode from the existing data-theme toggle', () => {
    // shadcn defaults to a .dark class; this app stamps data-theme on <html>.
    expect(css).toMatch(/data-theme='dark'|data-theme="dark"|data-theme=dark/);
  });

  it('omits preflight so the legacy stylesheet keeps working', () => {
    // Preflight's signature rules would reset the 490 legacy class selectors.
    expect(css).not.toMatch(/blockquote,\s*figure,\s*h1/);
    expect(css).not.toMatch(/list-style:\s*none/);
    // But the minimum utilities need must still be present.
    expect(css).toMatch(/box-sizing:\s*border-box/);
    expect(css).toMatch(/border-style:\s*solid/);
  });
});
