import { Text, View } from 'react-native';

import type { TechnicianDayRoute } from '@/src/repositories/contracts';
import { SectionHeader } from '@/src/components/ui';

/**
 * The technician's remaining stops, in the order worth driving them.
 *
 * A suggestion, never an instruction. Nothing records whether it was followed,
 * and it is recomputed from wherever they actually are — so taking a different
 * stop first produces a new suggestion a minute later rather than putting
 * anybody out of compliance with a plan they never agreed to.
 */

/** Minutes, or hours and minutes. Never seconds — see `estimated` below. */
function drive(seconds: number) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}

function miles(meters: number) {
  const value = meters / 1609.344;
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} mi`;
}

export function DayRouteSummary({ route }: { route?: TechnicianDayRoute }) {
  // Nothing to say yet, or nothing to plan. Silence is right for both: this
  // sits above a screen that already tells them what work they have, and an
  // empty box explaining why there is no route would be noise on a phone.
  // `legs`, not `stops`. The planner returns the day's stops whether or not it
  // managed to route them, so reading `stops` here showed a drive for a route
  // that had been refused -- a zero total, which `drive()` renders as a minute.
  // Two legs means at least two stops, so the "not worth showing for one stop"
  // rule is kept by the same check.
  if (!route || !route.origin || route.legs.length < 2) return null;

  return (
    <View className="mt-6">
      <SectionHeader title="Suggested order" />

      <View className="mt-2 rounded-2xl border border-border bg-card p-4">
        <View className="flex-row items-baseline gap-2">
          <Text className="text-2xl font-bold text-foreground">
            {drive(route.totalDurationSeconds)}
          </Text>
          <Text className="text-sm text-muted-foreground">
            driving · {miles(route.totalDistanceMeters)}
          </Text>
        </View>

        {/* Said out loud, because somebody is going to plan a day around it.
            The routing engine has no traffic data, so these times describe an
            empty road at the speed limit. */}
        <Text className="mt-1 text-xs text-muted-foreground">
          Estimate. Does not account for traffic.
        </Text>

        <View className="mt-3">
          {route.stops.map((stop, index) => {
            const leg = route.legs[index];
            return (
              <View
                key={stop.inspectionId}
                className="flex-row items-baseline gap-3 border-t border-border/60 py-2.5"
              >
                <Text className="w-4 text-sm text-muted-foreground">{index + 1}</Text>
                <View className="min-w-0 flex-1">
                  <Text className="font-medium text-foreground" numberOfLines={1}>
                    {stop.propertyName}
                  </Text>
                  <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                    {stop.addressLine1}, {stop.city}
                  </Text>
                </View>
                {leg ? (
                  <Text className="text-sm text-muted-foreground">{drive(leg.durationSeconds)}</Text>
                ) : null}
              </View>
            );
          })}
        </View>

        {/* Never dropped quietly: these inspections are still theirs to do, the
            address just could not be placed on a map. */}
        {route.unroutable.length ? (
          <Text className="mt-3 border-t border-border/60 pt-3 text-xs text-muted-foreground">
            Not in this order because the address could not be located:{' '}
            {route.unroutable.map((stop) => stop.propertyName).join(', ')}.
          </Text>
        ) : null}
      </View>
    </View>
  );
}
