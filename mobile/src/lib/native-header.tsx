import { useMemo } from 'react';
import { useHeaderHeight } from '@react-navigation/elements';
import type { NativeStackNavigationOptions } from '@react-navigation/native-stack';
import { Stack } from 'expo-router';
import { Platform, View, type ViewProps } from 'react-native';

import { useThemeColors } from './theme-colors';

/**
 * The platform's own navigation bar, on every screen (the office, 2026-10-07:
 * "more native to iOS... liquid glass").
 *
 * Every screen used to draw its own header: a round back button, a title and a
 * house, inside the scroll view. It looked like an app's own control because it
 * was one -- it never collapsed, never blurred what passed under it, and on
 * iOS 26 could not become Liquid Glass. These are UIKit's bars now.
 *
 * On iOS the bar is transparent and content scrolls under it. iOS 26, in a
 * build made with its SDK, draws that as Liquid Glass by itself; anything
 * earlier gets the system chrome blur the old tab bar used. Android keeps an
 * opaque bar, which is what its platform expects. Scroll views under an iOS bar
 * need `contentInsetAdjustmentBehavior="automatic"`; anything else uses
 * `BelowHeader`.
 */

/** iOS 26 and later draw the bars in Liquid Glass themselves. */
export const SYSTEM_GLASS =
  Platform.OS === 'ios' && Number.parseInt(String(Platform.Version), 10) >= 26;

export function useStackScreenOptions(): NativeStackNavigationOptions {
  const theme = useThemeColors();
  return useMemo(
    () =>
      Platform.OS === 'ios'
        ? {
            headerTransparent: true,
            ...(SYSTEM_GLASS
              ? {}
              : {
                  headerBlurEffect: theme.isDark
                    ? ('systemChromeMaterialDark' as const)
                    : ('systemChromeMaterialLight' as const),
                }),
            headerShadowVisible: false,
            headerLargeTitleShadowVisible: false,
            // The chevron alone, as iOS 26 draws it inside its glass button.
            headerBackButtonDisplayMode: 'minimal' as const,
            headerTintColor: theme.primary,
            headerTitleStyle: { color: theme.foreground },
            headerLargeTitleStyle: { color: theme.foreground },
            contentStyle: { backgroundColor: theme.background },
          }
        : {
            headerStyle: { backgroundColor: theme.background },
            headerTintColor: theme.foreground,
            headerTitleStyle: { color: theme.foreground },
            headerShadowVisible: false,
            contentStyle: { backgroundColor: theme.background },
          },
    [theme],
  );
}

/**
 * One tab's own stack: its screen under a large title, as every iOS app's top
 * level reads. The large title collapses into the bar as the list scrolls.
 */
export function TabStack({ screen, title }: { screen: string; title: string }) {
  const options = useStackScreenOptions();
  return (
    <Stack screenOptions={options}>
      <Stack.Screen name={screen} options={{ title, headerLargeTitle: Platform.OS === 'ios' }} />
    </Stack>
  );
}

/**
 * For content that does not scroll -- a loading state, a message -- so it
 * starts below a transparent iOS bar rather than under it. Android's bar is
 * opaque and already takes its own room.
 */
export function BelowHeader({ style, ...props }: ViewProps) {
  const height = useHeaderHeight();
  return (
    <View style={[{ flex: 1, paddingTop: Platform.OS === 'ios' ? height : 0 }, style]} {...props} />
  );
}
