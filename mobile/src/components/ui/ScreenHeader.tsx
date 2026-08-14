import { Text, View } from 'react-native';

/**
 * The title block at the top of a tab screen.
 *
 * Home, Inspections, Settings, Uploads and Login each rebuilt this by hand as
 * `px-5 pb-2 pt-4` + `text-2xl font-bold tracking-tight` + an optional
 * `mt-0.5 text-sm text-muted-foreground`. They happened to agree; nothing kept
 * them agreeing.
 *
 * `eyebrow` is for the one line of context above the title that a couple of
 * screens genuinely need — Home puts the date there. It is not a section label:
 * this app has no use for `01 / OVERVIEW` above a heading, and every existing
 * uppercase-tracking label in the codebase is either a settings group heading
 * or a real field name.
 */
export function ScreenHeader({
  title,
  subtitle,
  eyebrow,
  action,
}: {
  title: string;
  subtitle?: string;
  eyebrow?: string;
  /** A single trailing control, vertically centred against the title. */
  action?: React.ReactNode;
}) {
  return (
    <View className="flex-row items-start justify-between gap-3 px-5 pb-2 pt-4">
      <View className="min-w-0 flex-1">
        {eyebrow ? <Text className="text-sm text-muted-foreground">{eyebrow}</Text> : null}
        <Text
          accessibilityRole="header"
          className={`text-2xl font-bold tracking-tight text-foreground ${eyebrow ? 'mt-1' : ''}`}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text className="mt-0.5 text-sm text-muted-foreground">{subtitle}</Text>
        ) : null}
      </View>
      {action}
    </View>
  );
}

/**
 * A heading inside a screen, optionally with one trailing action.
 *
 * Seven screens repeated `text-lg font-semibold text-foreground` with a
 * hand-built "See all" Pressable beside it. The action keeps `min-h-11` because
 * a bare text link is the easiest thing in the app to miss with a thumb.
 */
export function SectionHeader({
  title,
  action,
  className = '',
}: {
  title: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <View className={`mb-3 flex-row items-center justify-between px-5 ${className}`}>
      <Text accessibilityRole="header" className="text-lg font-semibold text-foreground">
        {title}
      </Text>
      {action}
    </View>
  );
}

/**
 * The small uppercase label above a group of settings rows.
 *
 * Kept, because here it is doing real work — it names a group of controls that
 * would otherwise run together. It is not decoration, and it should not spread
 * to screens that just want a heading; those use `SectionHeader`.
 */
export function GroupLabel({ children }: { children: string }) {
  return (
    <Text
      accessibilityRole="header"
      className="mb-2 mt-6 px-5 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
    >
      {children}
    </Text>
  );
}
