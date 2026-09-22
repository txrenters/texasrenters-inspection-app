import { router } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { PRESS_SURFACE } from '@/src/components/ui';
import type { TechnicianDayRoute } from '@/src/repositories/contracts';

/**
 * The way into turn-by-turn navigation, on the day list.
 *
 * ## Why this is not inside `DayRouteSummary`
 *
 * That component returns null when the day has fewer than two legs, and the
 * guard is right for what it guards: a "suggested order" card listing one stop
 * is noise, and reading `stops` there once drew a drive for a route the planner
 * had refused.
 *
 * It is exactly wrong for this button. A technician with one job is the most
 * likely of all of them to want directions — they have one address and no
 * ordering to work out. Putting the button inside that guard would hide it from
 * the person who needs it most, so it lives beside the card instead and carries
 * its own, looser test.
 *
 * ## What it does test
 *
 * `legs`, never `stops`. The planner returns the day's stops whether or not it
 * managed to route them, so a day whose route was refused still has a full list
 * of them — offering to navigate it would open a screen that can only say it
 * has no route. One routed leg is the real floor.
 *
 * A route drawn from a position no road reaches is refused too: OSRM once
 * snapped a coordinate in the Philippines onto a road in east Texas and
 * answered a plausible four-hour drive, so `originOutsideServiceArea` means the
 * whole route is invention and must not be driven.
 */
export function StartDrivingButton({ route }: { route?: TechnicianDayRoute }) {
  if (!route || route.originOutsideServiceArea) return null;
  if (route.legs.length < 1) return null;

  const stops = route.legs.length;

  return (
    <View className="mt-4">
      <Pressable
        accessibilityLabel="Start driving the day"
        accessibilityRole="button"
        className={`h-14 flex-row items-center justify-center gap-2.5 rounded-xl bg-primary ${PRESS_SURFACE}`}
        onPress={() => router.push('/navigate')}
      >
        <Text className="text-base font-semibold text-primary-foreground">
          {stops > 1 ? 'Start driving the day' : 'Get directions'}
        </Text>
      </Pressable>

      <Text className="mt-2.5 px-0.5 text-xs leading-5 text-muted-foreground">
        {stops > 1
          ? 'Turn by turn to your next stop, then straight on to the rest without coming back here. Taking them in a different order is fine — the route redraws from wherever you actually are.'
          : 'Turn by turn to your stop.'}
      </Text>
    </View>
  );
}
