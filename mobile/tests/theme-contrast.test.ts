/**
 * The palette's contrast guarantees, as assertions.
 *
 * Eleven pairs failed WCAG AA before this test existed, and none of them were
 * obvious on a desk monitor — dark mode's `muted-foreground` sat at 3.27:1 and
 * carried every timestamp and address line in the app, at 12px, read outdoors.
 * The failures were only visible once someone measured them, which is exactly
 * the kind of thing that regresses the next time a colour gets nudged.
 *
 * This is deliberately about *pairs*, not individual values. A token is not
 * legible or illegible on its own; it is legible against the surface it lands
 * on. So the pairings the screens actually build are the ones asserted here.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { darkTokens, lightTokens } from '../theme';

type Rgb = [number, number, number];

function channels(token: string): Rgb {
  const parts = token.trim().split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some((value) => !Number.isFinite(value))) {
    throw new Error(`Expected an "r g b" token, got "${token}"`);
  }
  return parts as Rgb;
}

/** WCAG 2.1 relative luminance. */
function luminance([r, g, b]: Rgb): number {
  const linearise = (value: number) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linearise(r) + 0.7152 * linearise(g) + 0.0722 * linearise(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const first = luminance(a);
  const second = luminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * A translucent fill resolved against what sits behind it.
 *
 * Status pills draw text and background from one token — `text-chart-4` on
 * `bg-chart-4/15` — so the pairing only exists once the tint is composited.
 * Comparing the raw tokens would compare a colour against itself and report a
 * perfect 1:1 for a badge that is unreadable.
 */
function composite(fg: Rgb, bg: Rgb, alpha: number): Rgb {
  const blend = (top: number, bottom: number) => Math.round(alpha * top + (1 - alpha) * bottom);
  return [blend(fg[0], bg[0]), blend(fg[1], bg[1]), blend(fg[2], bg[2])];
}

const AA_TEXT = 4.5;
/** WCAG 1.4.11: a control's boundary needs 3:1 when it is what identifies the control. */
const AA_NON_TEXT = 3;
/** Not a WCAG figure. Below this a card fill stops reading as a separate surface. */
const SURFACE_SEPARATION = 1.1;

describe.each([
  ['light', lightTokens],
  ['dark', darkTokens],
])('%s theme', (_name, tokens) => {
  const t = (name: keyof typeof lightTokens) => channels(tokens[name]);

  describe('surfaces', () => {
    it('separates a card from the background without needing a border', () => {
      // Was 1.03:1 in light mode: white cards on a white screen, held together
      // only by a border at 1.34:1 against its own fill. Neither was visible,
      // so the app's main grouping device did not group anything.
      expect(contrast(t('--card'), t('--background'))).toBeGreaterThanOrEqual(
        SURFACE_SEPARATION,
      );
    });

    it('separates an inset row from the card holding it', () => {
      expect(contrast(t('--muted'), t('--card'))).toBeGreaterThanOrEqual(1.06);
    });

    it('gives a text field a boundary that can be seen', () => {
      // `--input` and `--border` held one value, so either dividers were too
      // heavy or field boundaries were too faint. They are separate now, and
      // this is the half that has to carry 3:1.
      expect(contrast(t('--input'), t('--card'))).toBeGreaterThanOrEqual(AA_NON_TEXT);
    });
  });

  describe('text', () => {
    it.each([
      ['foreground on card', '--foreground', '--card'],
      ['foreground on background', '--foreground', '--background'],
      ['muted-foreground on card', '--muted-foreground', '--card'],
      ['muted-foreground on background', '--muted-foreground', '--background'],
      ['muted-foreground on muted', '--muted-foreground', '--muted'],
      ['primary on background', '--primary', '--background'],
      ['primary on card', '--primary', '--card'],
      ['primary-foreground on primary', '--primary-foreground', '--primary'],
      ['destructive on card', '--destructive', '--card'],
    ] as const)('%s clears AA', (_label, fg, bg) => {
      expect(contrast(t(fg), t(bg))).toBeGreaterThanOrEqual(AA_TEXT);
    });
  });

  describe('status pills', () => {
    // Every one of these failed in light mode: 2.36:1 for chart-4, which is
    // amber text on its own pale amber wash. Fixing it is why the light-mode
    // chart tokens are ochre and brick rather than amber and coral — the token
    // has to survive being its own background.
    it.each(['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5'] as const)(
      '%s stays legible on a 15% tint of itself',
      (token) => {
        const tint = composite(t(token), t('--card'), 0.15);
        expect(contrast(t(token), tint)).toBeGreaterThanOrEqual(AA_TEXT);
      },
    );

    it('destructive stays legible on a 10% tint of itself', () => {
      const tint = composite(t('--destructive'), t('--card'), 0.1);
      expect(contrast(t('--destructive'), tint)).toBeGreaterThanOrEqual(AA_TEXT);
    });

    it('primary stays legible in the 10% icon wells', () => {
      const tint = composite(t('--primary'), t('--card'), 0.1);
      expect(contrast(t('--primary'), tint)).toBeGreaterThanOrEqual(AA_TEXT);
    });
  });

  it('carries a legible label on the solid chart-4 tab badge', () => {
    // Light mode's chart-4 is a dark ochre and dark mode's is a light amber, so
    // the badge label takes the opposing surface. A fixed white sat at 2.2:1 on
    // the amber.
    const label = _name === 'dark' ? t('--background') : t('--card');
    expect(contrast(label, t('--chart-4'))).toBeGreaterThanOrEqual(AA_TEXT);
  });
});

/**
 * `theme.ts` drives the running app; `global.css` is the pre-hydration
 * fallback. When they drifted the first frame rendered one palette and
 * everything after it rendered another, which reads as the brand flashing on
 * every cold start.
 */
describe('global.css mirrors theme.ts', () => {
  const css = readFileSync(join(__dirname, '..', 'global.css'), 'utf8');

  function block(selector: string): Map<string, string> {
    const start = css.indexOf(selector);
    const open = css.indexOf('{', start);
    const close = css.indexOf('}', open);
    const declarations = new Map<string, string>();
    for (const line of css.slice(open + 1, close).split(';')) {
      const [name, value] = line.split(':').map((part) => part.trim());
      if (name?.startsWith('--') && value) declarations.set(name, value);
    }
    return declarations;
  }

  it.each([
    ['light', ':root {', lightTokens],
    ['dark', '.dark,', darkTokens],
  ] as const)('%s', (_name, selector, tokens) => {
    const declared = block(selector);
    for (const [name, value] of Object.entries(tokens)) {
      // The sidebar tokens are consumed only through NativeWind, so the CSS
      // fallback does not restate them.
      if (name.startsWith('--sidebar')) continue;
      // Named in the assertion rather than looped over silently, so a failure
      // says which token drifted instead of just "expected 26 24 22".
      expect([name, declared.get(name)]).toEqual([name, value]);
    }
  });
});
