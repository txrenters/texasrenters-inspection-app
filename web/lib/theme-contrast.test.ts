/**
 * The palette's contrast guarantees, as assertions.
 *
 * This parses `app/globals.css` rather than importing a token module, because
 * the stylesheet IS the source of truth here: there is no TS mirror to drift
 * from it. A colour nudged in that file and not re-measured fails this suite.
 *
 * Deliberately about *pairs*, not individual values. A token is not legible or
 * illegible on its own; it is legible against the surface it lands on. So the
 * pairings the screens actually build are the ones asserted.
 *
 * The status-tint cases are the subtle ones. A badge renders its text on a tint
 * of *itself* over a card, so lightening the text lightens the surface under it
 * too and the ratio improves less than you would expect. Dark mode tints at 8%
 * for exactly this reason; light mode can afford 10%. Those alphas are declared
 * in `components/ui/badge.tsx` and mirrored here on purpose, so changing one
 * without the other is caught.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

type Oklch = [l: number, c: number, h: number];
type LinearRgb = [number, number, number];

const CSS = readFileSync(join(import.meta.dirname, '..', 'app', 'globals.css'), 'utf8');

/**
 * The palettes, by the selector that declares them: the classic console's
 * light and dark, and the Jobber-style shell's (components/jobber-shell).
 */
const SELECTORS = {
  ':root': ':root',
  '.dark': '.dark',
  jobber: "[data-shell='jobber']",
  'jobber-dark': ".dark [data-shell='jobber']",
} as const;
type Scope = keyof typeof SELECTORS;

/**
 * Where a scope's undeclared tokens come from, as the cascade resolves them.
 * The Jobber shell declares only what it changes -- the brand green, for one,
 * is the console's own in both shells. In dark mode its frame matches both the
 * light Jobber block and the dark one, so a token the dark block leaves out
 * falls to the light Jobber value before the classic dark one.
 */
const INHERITS: Partial<Record<Scope, Scope>> = { jobber: ':root', 'jobber-dark': 'jobber' };

/**
 * Reads one custom property out of a palette block.
 *
 * Scoped to the block rather than matched globally: `--primary` is declared in
 * every palette, and a global match would silently return whichever came first.
 * The selector must open its line, so `[data-shell='jobber']` is not found
 * inside `.dark [data-shell='jobber']`.
 */
function readToken(scope: Scope, name: string): string {
  const selector = SELECTORS[scope].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = new RegExp(`(?:^|\\n)${selector}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(CSS);
  if (!block) throw new Error(`No ${SELECTORS[scope]} block in globals.css`);
  const declaration = new RegExp(`--${name}:\\s*([^;]+);`).exec(block[1]);
  if (declaration) return declaration[1].trim();
  const parent = INHERITS[scope];
  if (parent) return readToken(parent, name);
  throw new Error(`No --${name} in ${SELECTORS[scope]}`);
}

function parseOklch(value: string): Oklch {
  const match = /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)/.exec(value);
  if (!match) throw new Error(`Not a plain oklch() colour: "${value}"`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** OKLCH to linear sRGB, per the Oklab reference conversion. */
function toLinearRgb([L, C, hDeg]: Oklch): LinearRgb {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** WCAG 2.1 relative luminance. Input is already linear, so no de-gamma step. */
function luminance([r, g, b]: LinearRgb): number {
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  return 0.2126 * clamp(r) + 0.7152 * clamp(g) + 0.0722 * clamp(b);
}

function contrast(a: LinearRgb, b: LinearRgb): number {
  const [hi, lo] = [luminance(a) + 0.05, luminance(b) + 0.05].sort((x, y) => y - x);
  return hi / lo;
}

/** Alpha-composites a tinted foreground over a surface, as `bg-x/10` renders. */
function composite(fg: LinearRgb, bg: LinearRgb, alpha: number): LinearRgb {
  return fg.map((channel, index) => channel * alpha + bg[index] * (1 - alpha)) as LinearRgb;
}

const colour = (scope: Scope, name: string) => toLinearRgb(parseOklch(readToken(scope, name)));

/** WCAG AA for body text. Everything asserted here is 12-14px, so this is the bar. */
const AA_BODY = 4.5;

/** See the file header: light tints at 10%, dark at 8%. */
const TINT_ALPHA = { ':root': 0.1, '.dark': 0.08 } as const;

describe.each([
  { mode: 'light', scope: ':root' as const },
  { mode: 'dark', scope: '.dark' as const },
])('$mode palette', ({ scope }) => {
  const surfaces = ['background', 'card', 'muted'] as const;

  it.each(surfaces)('foreground is readable on %s', (surface) => {
    expect(contrast(colour(scope, 'foreground'), colour(scope, surface))).toBeGreaterThanOrEqual(
      AA_BODY,
    );
  });

  /**
   * Held above the 4.5:1 floor rather than at it. This token carries the
   * timestamps, addresses and table headers that fill the console, at 12px,
   * for a whole working day.
   */
  it.each(surfaces)('muted-foreground is comfortable on %s', (surface) => {
    expect(contrast(colour(scope, 'muted-foreground'), colour(scope, surface))).toBeGreaterThan(5);
  });

  it.each(['success', 'warning', 'destructive', 'info'] as const)(
    '%s badge text is readable on its own tint',
    (tone) => {
      const text = colour(scope, tone);
      const tint = composite(text, colour(scope, 'card'), TINT_ALPHA[scope]);
      expect(contrast(text, tint)).toBeGreaterThanOrEqual(AA_BODY);
    },
  );

  it.each(['success', 'warning', 'destructive', 'info'] as const)(
    '%s is readable as plain text on a card',
    (tone) => {
      expect(contrast(colour(scope, tone), colour(scope, 'card'))).toBeGreaterThanOrEqual(AA_BODY);
    },
  );

  /**
   * The one accent is TEXT: the live figure on a card, and the page you are on
   * in the sidebar, where it sits on a tint of itself (the same alphas as a
   * status badge, for the same reason).
   */
  it.each(['card', 'background', 'sidebar'] as const)(
    'highlight is readable as text on %s',
    (surface) => {
      expect(contrast(colour(scope, 'highlight'), colour(scope, surface))).toBeGreaterThanOrEqual(
        AA_BODY,
      );
    },
  );

  it('highlight is readable on its own tint over the sidebar (the active nav item)', () => {
    const text = colour(scope, 'highlight');
    const tint = composite(text, colour(scope, 'sidebar'), TINT_ALPHA[scope]);
    expect(contrast(text, tint)).toBeGreaterThanOrEqual(AA_BODY);
  });

  it('primary button text is readable on the primary fill', () => {
    expect(
      contrast(colour(scope, 'primary-foreground'), colour(scope, 'primary')),
    ).toBeGreaterThanOrEqual(AA_BODY);
  });

  /**
   * The brand green is a fill, never a text colour, and its foreground is the
   * near-black that pairs with it. White here measures 2.0:1.
   */
  it('brand foreground is readable on the brand fill', () => {
    expect(
      contrast(colour(scope, 'brand-foreground'), colour(scope, 'brand')),
    ).toBeGreaterThanOrEqual(AA_BODY);
  });

  /**
   * The inspection stepper draws its tick and cross in `text-background` on a
   * solid status fill, so the glyph flips with the mode along with the fill.
   *
   * It used to be a hardcoded `text-white`, which is 6.2:1 on the light-mode
   * green and **1.95:1 on the dark-mode one** — the tick was simply not there in
   * dark mode. 3:1 is the bar (WCAG 1.4.11, non-text UI component; the step also
   * carries a written state beside it). Current headroom is roughly double that
   * in both modes, so a failure here means a token moved a long way.
   */
  it.each(['success', 'destructive', 'primary'] as const)(
    'a glyph in the page background colour stays visible on the %s fill',
    (tone) => {
      expect(contrast(colour(scope, 'background'), colour(scope, tone))).toBeGreaterThanOrEqual(3);
    },
  );

  /**
   * No drop shadow exists in this application, so a card is told apart from the
   * canvas by its surface and its border alone. Both have to actually differ.
   */
  it('card is a distinct surface from the canvas', () => {
    expect(contrast(colour(scope, 'card'), colour(scope, 'background'))).toBeGreaterThan(1.02);
  });
});

/**
 * The Jobber-style shell's palette (Atlantis's values; see the block's header
 * in globals.css). The same bars as the classic console, with two changes that
 * follow from how Jobber draws a page:
 *
 * - There is no "card vs canvas" pair. The page and its cards are the same
 *   white, told apart by a border. What has to differ is the page from the
 *   taupe frame around it (the sidebar and the top bar).
 * - The sidebar's page-you-are-on is the white page colour in bold, not a tint,
 *   so the pairs asserted are the nav text on the frame, on the hovered row and
 *   on that white.
 */
describe.each([
  { mode: 'light', scope: 'jobber' as const, alpha: 0.1 },
  { mode: 'dark', scope: 'jobber-dark' as const, alpha: 0.08 },
])('Jobber-style shell, $mode palette', ({ scope, alpha }) => {
  const surfaces = ['background', 'card', 'muted', 'sidebar'] as const;

  it.each(surfaces)('foreground is readable on %s', (surface) => {
    expect(contrast(colour(scope, 'foreground'), colour(scope, surface))).toBeGreaterThanOrEqual(
      AA_BODY,
    );
  });

  it.each(surfaces)('muted-foreground is comfortable on %s', (surface) => {
    expect(contrast(colour(scope, 'muted-foreground'), colour(scope, surface))).toBeGreaterThan(5);
  });

  it('headings are readable on the page', () => {
    expect(contrast(colour(scope, 'heading'), colour(scope, 'card'))).toBeGreaterThanOrEqual(AA_BODY);
  });

  it.each(['success', 'warning', 'destructive', 'info'] as const)(
    '%s badge text is readable on its own tint',
    (tone) => {
      const text = colour(scope, tone);
      const tint = composite(text, colour(scope, 'card'), alpha);
      expect(contrast(text, tint)).toBeGreaterThanOrEqual(AA_BODY);
    },
  );

  it.each(['success', 'warning', 'destructive', 'info'] as const)(
    '%s is readable as plain text on the page',
    (tone) => {
      expect(contrast(colour(scope, tone), colour(scope, 'card'))).toBeGreaterThanOrEqual(AA_BODY);
    },
  );

  it.each(['card', 'background', 'sidebar'] as const)(
    'highlight is readable as text on %s',
    (surface) => {
      expect(contrast(colour(scope, 'highlight'), colour(scope, surface))).toBeGreaterThanOrEqual(
        AA_BODY,
      );
    },
  );

  it.each([
    ['primary-foreground', 'primary'],
    ['destructive-foreground', 'destructive'],
    ['brand-foreground', 'brand'],
  ] as const)('%s is readable on the %s fill', (text, fill) => {
    expect(contrast(colour(scope, text), colour(scope, fill))).toBeGreaterThanOrEqual(AA_BODY);
  });

  it.each(['sidebar', 'sidebar-hover', 'sidebar-accent'] as const)(
    'the navigation is readable on %s',
    (surface) => {
      expect(
        contrast(colour(scope, 'sidebar-foreground'), colour(scope, surface)),
      ).toBeGreaterThanOrEqual(AA_BODY);
    },
  );

  it.each(['success', 'destructive', 'primary'] as const)(
    'a glyph in the page background colour stays visible on the %s fill',
    (tone) => {
      expect(contrast(colour(scope, 'background'), colour(scope, tone))).toBeGreaterThanOrEqual(3);
    },
  );

  it('the page is a distinct surface from the frame around it', () => {
    expect(contrast(colour(scope, 'card'), colour(scope, 'sidebar'))).toBeGreaterThan(1.05);
  });
});
