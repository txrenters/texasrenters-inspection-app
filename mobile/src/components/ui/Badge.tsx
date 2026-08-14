import { Text, View } from 'react-native';

/**
 * The semantic ramp. Named for what a status means, not what colour it is, so a
 * palette change does not have to revisit every call site.
 */
export type BadgeTone =
  | 'neutral'
  | 'pending'
  | 'active'
  | 'done'
  | 'attention'
  | 'critical';

type BadgeProps = {
  label: string;
  tone?: BadgeTone;
  /** Give it `size={12}`; the tone class is applied for you. */
  icon?: (props: { className: string }) => React.ReactNode;
  className?: string;
};

/**
 * Tone to fill and text.
 *
 * ## The tint had to be measured, not chosen
 *
 * A badge takes its text and its background from one token — `text-chart-4` on
 * `bg-chart-4/15` — so the token has to stay legible against a 15% wash of
 * itself. In light mode none of them did:
 *
 *   chart-1  2.63:1    chart-2  3.08:1    chart-3  3.81:1    chart-4  2.36:1
 *
 * Amber text on pale amber, at 12px, outdoors. The light-mode chart tokens are
 * darker now (ochre and brick rather than amber and coral) purely so this
 * pairing works; dark mode's stayed bright because there they already passed.
 * Every tone below clears 4.5:1 in both modes.
 *
 * The tint stays at 15% for the coloured tones and 10% for `critical`, matching
 * what the screens already used — the fix was the token, not the opacity.
 */
const TONE: Record<BadgeTone, { bg: string; text: string }> = {
  neutral: { bg: 'bg-muted', text: 'text-muted-foreground' },
  pending: { bg: 'bg-chart-4/15', text: 'text-chart-4' },
  active: { bg: 'bg-chart-2/15', text: 'text-chart-2' },
  done: { bg: 'bg-chart-3/15', text: 'text-chart-3' },
  attention: { bg: 'bg-chart-1/15', text: 'text-chart-1' },
  critical: { bg: 'bg-destructive/10', text: 'text-destructive' },
};

/**
 * A status pill.
 *
 * `rounded-full` is the locked shape for pills, and the label is never
 * transformed by the stylesheet. Lowercasing then re-`capitalize`-ing round
 * trips badly on a hyphen — "Follow-up Needed" came back "Follow-Up Needed",
 * and differently on the list screen than on the detail screen. Pass the label
 * already cased.
 */
export function Badge({ label, tone = 'neutral', icon, className = '' }: BadgeProps) {
  const { bg, text } = TONE[tone];
  return (
    <View className={`flex-row items-center gap-1 rounded-full px-2.5 py-0.5 ${bg} ${className}`}>
      {icon?.({ className: text })}
      <Text className={`text-xs font-semibold ${text}`}>{label}</Text>
    </View>
  );
}

export const BADGE_TONE_CLASS = TONE;
