import { vars } from "nativewind";

export interface ThemeFonts {
  heading: {
    family: string;
    weights: Record<string, string>;
  };
  body: {
    family: string;
    weights: Record<string, string>;
  };
  mono: {
    family: string;
    weights: Record<string, string>;
  };
}

export const themeFonts: ThemeFonts = {
  heading: {
    family: 'Inter',
    weights: {
      normal: 'Inter_400Regular',
      medium: 'Inter_500Medium',
      semibold: 'Inter_600SemiBold',
      bold: 'Inter_700Bold',
    },
  },
  body: {
    family: 'Inter',
    weights: {
      normal: 'Inter_400Regular',
      medium: 'Inter_500Medium',
      semibold: 'Inter_600SemiBold',
    },
  },
  mono: {
    family: 'JetBrainsMono',
    weights: {
      normal: 'JetBrainsMono_400Regular',
      medium: 'JetBrainsMono_500Medium',
    },
  },
};

/**
 * TexasRenters field inspection palette.
 *
 * ## One neutral family, both modes
 *
 * These used to disagree: light was warm stone (background `252 251 248`,
 * muted-foreground `120 113 105`) while dark was cool slate (`10 15 24`,
 * `94 107 120`) — and light's own foreground was slate `15 23 42` sitting on a
 * warm background. Switching modes changed the brand, not just the brightness.
 * Both are warm neutrals now; deep teal stays the single chromatic voice.
 *
 * ## Every pair is measured, not eyeballed
 *
 * This app is read one-handed, outdoors, in whatever light the property has, so
 * contrast is a functional requirement rather than a compliance checkbox. Every
 * pair below meets WCAG AA (4.5:1 for text, 3:1 for control boundaries).
 *
 * Eleven pairs failed before. The ones that mattered most in the field:
 *
 * - **Cards were invisible.** `card` was `255 255 255` on a `252 251 248`
 *   background — 1.03:1. Every card in the app was a white rectangle on a white
 *   screen, held together only by a border too faint to see. The background is
 *   deeper now, so a card reads as a raised surface on its own fill (1.12:1).
 * - **Dark mode's secondary text failed everywhere.** `muted-foreground` on a
 *   card was 3.27:1 — and that token carries every timestamp, address line and
 *   status description in the app, at 12px.
 * - **Status badges were unreadable in light mode.** `text-chart-4` on
 *   `bg-chart-4/15` was 2.36:1: amber text on its own pale amber tint.
 *
 * ## Why the chart colours differ so much between modes
 *
 * A badge draws its text *and* its background from one token (`text-chart-4` on
 * `bg-chart-4/15`), so the token has to be legible against a 15% wash of
 * itself. That forces it dark on a light surface and bright on a dark one.
 * Light mode's ochre and brick are the same semantic ramp as dark mode's amber
 * and coral, resolved for the surface underneath.
 *
 * ## `--border` and `--input` are deliberately different now
 *
 * They held the same value, which meant one of them was always wrong. A card
 * divider is decoration — the fill already separates the surfaces, so it stays
 * quiet. A text field's boundary is the only thing telling you where to tap, so
 * it carries the 3:1 that WCAG 1.4.11 asks of a control boundary.
 *
 * Verified by `npm test --workspace @texasrenters/mobile -- theme-contrast`.
 */

/**
 * The tokens as plain data, so they have exactly one definition.
 *
 * `vars()` returns an opaque style object, so anything needing a real colour
 * value — `tintColor`, `placeholderTextColor`, `trackColor`, `tabBarStyle`, any
 * React Native prop that predates className support — used to hardcode a hex
 * literal instead. That was 45 literals across 14 files, and they had already
 * drifted: the two placeholders on the area screen rendered different greys.
 *
 * `src/lib/theme-colors.ts` resolves these for that case. Everything else keeps
 * using semantic classNames.
 */
export const lightTokens = {
  "--radius": "12",

  "--background": "244 242 237",
  "--foreground": "26 24 22",

  "--card": "255 255 255",
  "--card-foreground": "26 24 22",

  "--popover": "255 255 255",
  "--popover-foreground": "26 24 22",

  "--primary": "17 78 69",
  "--primary-foreground": "247 254 252",

  "--secondary": "236 233 228",
  "--secondary-foreground": "17 78 69",

  "--muted": "236 233 228",
  "--muted-foreground": "87 81 75",

  "--accent": "238 234 227",
  "--accent-foreground": "17 78 69",

  "--destructive": "168 22 22",

  "--border": "224 220 213",
  "--input": "150 143 134",
  "--ring": "17 78 69",

  "--chart-1": "166 62 38",
  "--chart-2": "13 110 96",
  "--chart-3": "42 106 76",
  "--chart-4": "146 87 15",
  "--chart-5": "109 74 150",

  "--sidebar": "240 237 232",
  "--sidebar-foreground": "26 24 22",
  "--sidebar-primary": "17 78 69",
  "--sidebar-primary-foreground": "247 254 252",
  "--sidebar-accent": "236 233 228",
  "--sidebar-accent-foreground": "17 78 69",
  "--sidebar-border": "224 220 213",
  "--sidebar-ring": "17 78 69",
} as const;

export const darkTokens = {
  "--radius": "12",

  "--background": "18 17 16",
  "--foreground": "242 240 236",

  "--card": "30 28 26",
  "--card-foreground": "242 240 236",

  "--popover": "36 34 31",
  "--popover-foreground": "242 240 236",

  "--primary": "45 212 191",
  "--primary-foreground": "6 42 37",

  "--secondary": "42 40 37",
  "--secondary-foreground": "242 240 236",

  "--muted": "42 40 37",
  "--muted-foreground": "167 160 151",

  "--accent": "48 45 42",
  "--accent-foreground": "242 240 236",

  "--destructive": "248 113 113",

  "--border": "54 51 47",
  "--input": "110 104 97",
  "--ring": "45 212 191",

  "--chart-1": "248 150 120",
  "--chart-2": "45 212 191",
  "--chart-3": "110 231 158",
  "--chart-4": "251 196 110",
  "--chart-5": "190 150 225",

  "--sidebar": "24 23 21",
  "--sidebar-foreground": "242 240 236",
  "--sidebar-primary": "45 212 191",
  "--sidebar-primary-foreground": "6 42 37",
  "--sidebar-accent": "42 40 37",
  "--sidebar-accent-foreground": "242 240 236",
  "--sidebar-border": "54 51 47",
  "--sidebar-ring": "45 212 191",
} as const;

export type ThemeTokenName = keyof typeof lightTokens;

export const lightTheme = vars(lightTokens);
export const darkTheme = vars(darkTokens);
