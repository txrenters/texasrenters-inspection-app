import { useColorScheme } from 'nativewind';

import { darkTokens, lightTokens, type ThemeTokenName } from '@/theme';

/**
 * Theme colours as real values, for the React Native props that cannot take a
 * className.
 *
 * `tintColor`, `placeholderTextColor`, `trackColor`, `thumbColor`,
 * `tabBarStyle`, `tabBarActiveTintColor` and friends all predate NativeWind's
 * className support, so every screen needing one reached for a hex literal and
 * an `isDark` ternary. That came to 45 literals across 14 files, and they had
 * already drifted apart:
 *
 * - The area screen used `#94a3b8`/`#64748b` for the rename placeholder and
 *   `#9a9484`/`#5e6b78` for the skip placeholder — two different greys on one
 *   screen, and the first pair was left over from a slate palette the app no
 *   longer used.
 * - The settings switch tracked `#14967d`, which was `--chart-2` rather than
 *   `--primary`, and used the same value in both themes.
 * - The tab bar restated `--background`, `--border`, `--primary` and
 *   `--muted-foreground` as six literals, so a palette change silently left the
 *   one piece of chrome visible on every screen behind.
 *
 * Resolved from the same token maps the stylesheet uses, so a palette change is
 * one edit again.
 */

const CHANNELS = /^(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})$/;

/**
 * Tokens are stored as `"r g b"` so Tailwind can splice an alpha channel in.
 * React Native wants `#rrggbb`.
 *
 * `--radius` lives in the same map and is not a colour, so anything that does
 * not parse as three channels is returned untouched rather than throwing — a
 * malformed token should not take a screen down over a placeholder colour.
 */
function toHex(token: string): string {
  const match = CHANNELS.exec(token.trim());
  if (!match) return token;
  return `#${match
    .slice(1)
    .map((channel) => Math.min(255, Number(channel)).toString(16).padStart(2, '0'))
    .join('')}`;
}

export function themeColor(name: ThemeTokenName, isDark: boolean): string {
  return toHex((isDark ? darkTokens : lightTokens)[name]);
}

/**
 * Every colour token for the active scheme, already hex.
 *
 * Built fresh per call rather than memoised: it is a dozen string operations,
 * and caching it per scheme was the kind of thing that survives a theme edit
 * and serves the old palette until reload.
 */
export function themeColors(isDark: boolean) {
  const tokens = isDark ? darkTokens : lightTokens;
  return {
    background: toHex(tokens['--background']),
    foreground: toHex(tokens['--foreground']),
    card: toHex(tokens['--card']),
    cardForeground: toHex(tokens['--card-foreground']),
    primary: toHex(tokens['--primary']),
    primaryForeground: toHex(tokens['--primary-foreground']),
    muted: toHex(tokens['--muted']),
    mutedForeground: toHex(tokens['--muted-foreground']),
    border: toHex(tokens['--border']),
    input: toHex(tokens['--input']),
    destructive: toHex(tokens['--destructive']),
    chart1: toHex(tokens['--chart-1']),
    chart2: toHex(tokens['--chart-2']),
    chart3: toHex(tokens['--chart-3']),
    chart4: toHex(tokens['--chart-4']),
    chart5: toHex(tokens['--chart-5']),
  };
}

export type ThemeColors = ReturnType<typeof themeColors>;

/**
 * The active scheme's colours, plus the `isDark` flag screens were already
 * computing by hand.
 *
 * Returning both means a screen that needs a colour and a screen that needs the
 * flag call the same hook, instead of one importing `useColorScheme` for a
 * ternary over two literals.
 */
export function useThemeColors(): ThemeColors & { isDark: boolean } {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  return { ...themeColors(isDark), isDark };
}
