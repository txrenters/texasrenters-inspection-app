import { ExternalLinkIcon, TriangleAlertIcon, WifiOffIcon } from 'lucide-react-native';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { Button, Card, PRESS_SURFACE } from '@/src/components/ui';
import { registerIcons } from '@/src/lib/icons';

import { navMiles, roughBearing, useNavColors } from './nav-colors';

registerIcons(ExternalLinkIcon, TriangleAlertIcon, WifiOffIcon);

/**
 * What the screen says when there is no line to draw.
 *
 * ## Why this is a screen and not an error toast
 *
 * Routing has been silently empty before — see `routing-runs-on-google-not-osrm`,
 * where routes came back empty for months and nobody could tell, and the
 * billing outage where every call failed at once. In both cases the technician's
 * day was completely fine; only the drawn line was missing. A toast that
 * disappears leaves them with a blank map and no idea whether the work is still
 * there.
 *
 * So the failure is stated, the blame is placed where it belongs, and the day
 * is still listed — with a straight-line distance and a direction, which are
 * the two things that can be computed on the phone with no service at all.
 * Every stop keeps a way out to a working navigator.
 *
 * ## Why "roughly"
 *
 * The distance is a crow-flies haversine and the bearing is a straight line
 * across a road network that does not go straight. Both are useful for "is that
 * the far side of town or the next street", and neither is a direction to
 * drive. The wording has to carry that, or somebody will follow it.
 */

export interface NoRouteStop {
  /**
   * Not named `id`. `reconcileMobileState` treats any object with a string
   * `id` as a revisioned entity and can resurrect one the server has removed,
   * which on this screen would mean a stop that is no longer the technician's
   * reappearing in their day.
   */
  stopId: string;
  propertyName: string;
  addressLine?: string;
  /** Straight-line metres from where the technician is now. */
  distanceMeters: number;
  /** Degrees clockwise from north, straight line. */
  bearingDegrees: number;
}

export function NoRouteScreen({
  stops,
  unroutable = [],
  lastTriedLabel,
  retryEverySeconds = 30,
  retrying = false,
  onRetry,
  onOpenInMaps,
}: {
  stops: readonly NoRouteStop[];
  /** Addresses the planner could not place at all, with its reason if it gave one. */
  unroutable?: readonly { propertyName: string; reason: string | null }[];
  /** When the last attempt was made — "12:04 PM" — or null before the first. */
  lastTriedLabel: string | null;
  retryEverySeconds?: number;
  retrying?: boolean;
  onRetry: () => void;
  onOpenInMaps: (stopId: string) => void;
}) {
  const colors = useNavColors();

  return (
    // `contentContainerStyle`, not a className on the content container: every
    // other scrolling screen in the app styles it this way, and NativeWind's
    // className support for it varies by version.
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{ gap: 16, paddingHorizontal: 20, paddingVertical: 32 }}
    >
      <View className="items-center gap-2">
        <WifiOffIcon className="text-muted-foreground" size={34} />
        <Text accessibilityRole="header" className="text-2xl font-bold tracking-tight text-foreground">
          No route to draw
        </Text>
        <Text className="text-center text-sm leading-5 text-muted-foreground">
          The routing service did not answer. This is not a problem with your day.
        </Text>
      </View>

      {unroutable.length ? (
        <View
          className="flex-row items-start gap-2.5 rounded-xl px-4 py-3"
          style={{ backgroundColor: colors.warningWash }}
        >
          <TriangleAlertIcon className="text-chart-4" size={17} />
          <Text className="min-w-0 flex-1 text-sm leading-5" style={{ color: colors.warning }}>
            {/* Named, never dropped quietly: these inspections are still theirs
                to do, the address just could not be placed on a map. */}
            {unroutable.length === 1 ? 'This address could not be placed' : 'These addresses could not be placed'}
            : {unroutable.map((stop) => stop.propertyName).join(', ')}.
          </Text>
        </View>
      ) : null}

      <View className="gap-2">
        {stops.map((stop) => (
          <Card density="row" key={stop.stopId}>
            <View className="flex-row items-center gap-3">
              <View className="min-w-0 flex-1">
                <Text className="font-semibold text-foreground" numberOfLines={1}>
                  {stop.propertyName}
                </Text>
                {stop.addressLine ? (
                  <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                    {stop.addressLine}
                  </Text>
                ) : null}
                <Text className="mt-0.5 text-xs text-muted-foreground">
                  {navMiles(stop.distanceMeters)} away, roughly {roughBearing(stop.bearingDegrees)}
                </Text>
              </View>

              <Pressable
                accessibilityHint="Leaves this app"
                accessibilityLabel={`Open ${stop.propertyName} in Maps`}
                accessibilityRole="button"
                className={`min-h-11 flex-row items-center gap-1.5 rounded-full px-3.5 ${PRESS_SURFACE}`}
                onPress={() => onOpenInMaps(stop.stopId)}
                style={{ backgroundColor: colors.wash }}
              >
                <ExternalLinkIcon className="text-primary" size={14} />
                <Text className="text-xs font-bold" style={{ color: colors.washText }}>
                  Open in Maps
                </Text>
              </Pressable>
            </View>
          </Card>
        ))}
      </View>

      <View className="gap-2">
        <Button busy={retrying} busyLabel="Trying…" label="Try again" onPress={onRetry} variant="ghost" />
        {/* Said out loud so nobody sits pressing the button. The retry belongs
            to the engine; this only reports it. */}
        <Text className="text-center text-xs text-muted-foreground">
          {lastTriedLabel ? `Last tried ${lastTriedLabel} · ` : ''}retrying on its own every{' '}
          {retryEverySeconds} seconds
        </Text>
      </View>
    </ScrollView>
  );
}
