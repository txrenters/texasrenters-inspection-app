import { cssInterop } from 'nativewind';

/** Whatever `cssInterop` itself accepts — derived so it cannot drift. */
type StyleableComponent = Parameters<typeof cssInterop>[0];

/**
 * Make Lucide icons accept `className`.
 *
 * Lucide's React Native components take a `color` prop, not a style, so
 * NativeWind has to be told to map the resolved colour across. Every screen was
 * repeating this registration — 16 files, 39 lines of identical boilerplate —
 * which meant a new screen either duplicated it again or silently rendered
 * icons in the default colour.
 *
 * Registration is global and idempotent, so calling this at module scope in
 * each file that imports icons is correct and cheap.
 */
export function registerIcons(...icons: StyleableComponent[]): void {
  for (const icon of icons) {
    cssInterop(icon, { className: { target: 'style', nativeStyleToProp: { color: true } } });
  }
}
