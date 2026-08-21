import { ArrowLeftIcon, ChevronLeftIcon } from 'lucide-react-native';
import { Platform } from 'react-native';

import { registerIcons } from '@/src/lib/icons';

registerIcons(ArrowLeftIcon);
registerIcons(ChevronLeftIcon);

/**
 * The "go back" glyph, per platform.
 *
 * iOS draws a chevron. Android draws an arrow. Every screen in this app drew an
 * arrow, which on an iPhone is the one navigation control that visibly belongs
 * to a different operating system — it is the glyph Material uses for "up", and
 * next to a system back gesture it reads as a foreign control rather than as
 * chrome.
 *
 * Only the glyph is centralised here. The button around it is deliberately left
 * to each screen: the detail screens put it in a `rounded-full bg-card` circle,
 * and the camera draws it white over live video, and those are different
 * problems that happen to share a symbol.
 *
 * The chevron is drawn heavier and slightly larger than the arrow it replaces.
 * A chevron is two strokes where an arrow is a stroke plus a head, so at equal
 * point size and stroke weight it carries about a third less ink and reads as a
 * smaller, fainter target. Apple's own back chevron is noticeably bold for the
 * same reason. `strokeWidth` 2.5 and a 1.15x size restore the optical weight
 * without changing any screen's layout, since the containers are fixed-size.
 */
export function BackGlyph({ size, className }: { size: number; className?: string }) {
  if (Platform.OS !== 'ios') {
    return <ArrowLeftIcon size={size} className={className} />;
  }
  return <ChevronLeftIcon size={Math.round(size * 1.15)} strokeWidth={2.5} className={className} />;
}
