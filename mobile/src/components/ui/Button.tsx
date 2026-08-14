import { Pressable, Text, View, type PressableProps } from 'react-native';

import { PRESS_SURFACE } from './press';

/**
 * Four levels of emphasis plus a destructive one, which is every button the app
 * actually has:
 *
 * - `primary`   the one thing to do on the screen
 * - `secondary` an alternative to it, equally available
 * - `ghost`     a low-emphasis action, still brand-tinted (retry, re-run)
 * - `quiet`     tertiary, deliberately easy to skip past (skip a room)
 * - `destructive`
 */
type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'quiet' | 'destructive';

type ButtonProps = Omit<PressableProps, 'children' | 'style'> & {
  label: string;
  /** Shown in place of `label` while `busy`, so the control keeps its width. */
  busyLabel?: string;
  variant?: ButtonVariant;
  busy?: boolean;
  /** Rendered before the label. Give it `className="text-primary-foreground"` to match. */
  icon?: React.ReactNode;
  className?: string;
};

/**
 * The app's one button.
 *
 * Every screen hand-rolled these, so the same control varied by screen: the
 * area screen's primary action was `rounded-xl bg-primary py-3.5`, the login
 * button added `min-h-12`, the retry button used `rounded-xl bg-muted py-3`
 * with primary-coloured text, and the disabled states were spelled three
 * different ways (`bg-primary/40`, `bg-muted`, `opacity-70`). None of that was
 * deliberate.
 *
 * ## Disabled is a fill change, not an opacity change
 *
 * `opacity-70` over a primary fill drags the label down with the background, so
 * a disabled button in bright sun was the least readable thing on the screen.
 * `bg-primary/40` did the same. The disabled state uses `muted` with
 * `muted-foreground` instead — both measured against each other, so the label
 * stays legible while clearly reading as unavailable.
 *
 * ## Busy is not disabled
 *
 * A busy button reports `accessibilityState.busy` and keeps its own fill, so a
 * screen reader says "busy" rather than going quiet. It still blocks presses.
 */
export function Button({
  label,
  busyLabel,
  variant = 'primary',
  busy = false,
  disabled = false,
  icon,
  className = '',
  accessibilityLabel,
  ...rest
}: ButtonProps) {
  const inert = disabled || busy;

  // `min-h-12` on every variant: 48dp is the smallest target a gloved thumb
  // hits reliably, and this app is used standing up in someone else's kitchen.
  const base = `min-h-12 flex-row items-center justify-center gap-2 rounded-xl px-4 py-3.5 ${PRESS_SURFACE}`;

  const fill: Record<ButtonVariant, string> = {
    primary: 'bg-primary',
    secondary: 'border border-border bg-card',
    ghost: 'bg-muted',
    quiet: '',
    destructive: 'bg-destructive',
  };

  const text: Record<ButtonVariant, string> = {
    primary: 'text-primary-foreground',
    secondary: 'text-foreground',
    ghost: 'text-primary',
    quiet: 'text-muted-foreground',
    destructive: 'text-primary-foreground',
  };

  // `quiet` keeps its lack of fill when inert — giving it one would make the
  // disabled state louder than the enabled one.
  const inertFill = variant === 'quiet' ? '' : 'bg-muted';

  return (
    <Pressable
      accessibilityLabel={accessibilityLabel ?? (busy ? (busyLabel ?? label) : label)}
      accessibilityRole="button"
      accessibilityState={{ busy, disabled: inert }}
      className={`${base} ${inert ? inertFill : fill[variant]} ${className}`}
      disabled={inert}
      {...rest}
    >
      {/* Grouped and hidden: the Pressable already carries the whole label, and
          without this a screen reader stops once on the icon and again on the
          text. */}
      <View importantForAccessibility="no-hide-descendants" className="flex-row items-center gap-2">
        {busy ? null : icon}
        <Text
          className={`text-base font-bold ${inert ? 'text-muted-foreground' : text[variant]}`}
          numberOfLines={1}
        >
          {busy ? (busyLabel ?? label) : label}
        </Text>
      </View>
    </Pressable>
  );
}
