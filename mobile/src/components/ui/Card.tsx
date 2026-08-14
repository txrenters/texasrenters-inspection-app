import { View, type ViewProps } from 'react-native';

type CardProps = ViewProps & {
  /**
   * `feature` for a section panel, `row` for a list item.
   *
   * The only difference is internal padding — 20 against 16. Both were already
   * in use (26 cards at `p-5`, 17 at `p-4`, plus one `p-6` and one `p-8`),
   * roughly along those lines but not reliably.
   */
  density?: 'feature' | 'row';
  className?: string;
};

/**
 * A raised surface.
 *
 * ## Why cards needed fixing at the token level, not here
 *
 * `bg-card` was `255 255 255` on a `252 251 248` background: 1.03:1, which is
 * not a visible difference. Cards were held together entirely by
 * `border-border` at 1.34:1 against their own fill — also not visible. So the
 * app's primary grouping device did not read as a group at all; screens looked
 * like unstructured stacks of text.
 *
 * The background is deeper now (1.12:1 against the card), so the fill does the
 * work a card fill is supposed to do and no border is needed. That is why this
 * component has none, and why the skeletons stopped drawing one.
 *
 * ## The skeletons disagreed with the real thing
 *
 * `InspectionCardSkeleton` drew `rounded-2xl border border-border bg-card p-4`
 * while the row it stood in for drew `rounded-2xl bg-card p-4` — bordered while
 * loading, borderless once loaded. The list visibly changed texture when data
 * arrived. Both go through this component now, so they cannot disagree again.
 */
export function Card({ density = 'feature', className = '', children, ...rest }: CardProps) {
  return (
    <View
      className={`rounded-2xl bg-card ${density === 'feature' ? 'p-5' : 'p-4'} ${className}`}
      {...rest}
    >
      {children}
    </View>
  );
}

/**
 * A card that groups rows, with the padding on the rows instead.
 *
 * `overflow-hidden` so the first and last row's fill clips to the corner radius
 * — settings had this right, most other grouped lists did not and showed a
 * square corner poking out from under a rounded one on press.
 */
export function CardGroup({ className = '', children, ...rest }: ViewProps & { className?: string }) {
  return (
    <View className={`overflow-hidden rounded-2xl bg-card ${className}`} {...rest}>
      {children}
    </View>
  );
}
