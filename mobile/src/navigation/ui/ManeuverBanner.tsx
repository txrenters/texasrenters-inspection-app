import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';

import type { NavManeuver } from '@texasrenters/shared';

import { useReducedMotion } from '@/src/lib/reduced-motion';

import { ManeuverIcon } from './ManeuverIcon';
import { navDistance, useNavColors } from './nav-colors';

/**
 * The next turn, across the top of the map.
 *
 * The one piece of chrome a driver is allowed to read at speed, so it carries
 * exactly three things: how far, what to do, and what comes after. Everything
 * else about the drive — the remaining time, the address, the day — is in the
 * HUD at the bottom, where a glance costs more.
 *
 * ## Why the distance is the biggest thing on the screen
 *
 * It is the only value that changes continuously, and it is the one that
 * answers "is this my turn". The instruction under it is a sentence, and a
 * sentence at 34px would take the banner to three lines and push the map off
 * the screen — so the instruction is ellipsised rather than wrapped. The
 * router's own words are always right (see `NavigationStep.instruction`), but
 * they are also sometimes forty characters long, and the arrow beside them has
 * already said which way.
 *
 * ## Why the corners are only rounded at the bottom
 *
 * The banner runs under the status bar. Rounding the top would leave two slivers
 * of map either side of the clock, which reads as a rendering fault rather than
 * as a design.
 */

export type BannerTone = 'NORMAL' | 'OFF_ROUTE';

export function ManeuverBanner({
  maneuver,
  instruction,
  distanceMeters,
  then,
  tone = 'NORMAL',
}: {
  maneuver: NavManeuver;
  /** The router's own sentence. Never rewritten here. */
  instruction: string;
  distanceMeters: number;
  /** The turn after this one, or null when this is the last. */
  then?: { maneuver: NavManeuver; text: string } | null;
  tone?: BannerTone;
}) {
  const colors = useNavColors();
  const offRoute = tone === 'OFF_ROUTE';
  const background = offRoute ? colors.warning : colors.banner;

  // On the warning fill the text colour has to flip with the theme: light
  // mode's warning is a dark ochre that wants near-white on it, dark mode's is
  // a pale amber that wants near-black. The banner green wants near-white in
  // both. Getting this wrong is the ochre-on-ochre failure `theme.ts` records
  // for badges, at 34px instead of 12.
  const onWarning = colors.isDark ? colors.background : colors.bannerText;
  const primaryText = offRoute ? onWarning : colors.bannerText;
  const secondaryText = offRoute ? onWarning : colors.bannerMuted;

  const distance = navDistance(distanceMeters);

  return (
    <View
      accessible
      accessibilityLabel={offRoute ? 'Off the route. Finding a new way.' : `${distance}. ${instruction}`}
      accessibilityLiveRegion="polite"
      style={[styles.banner, { backgroundColor: background }]}
    >
      <View style={styles.main}>
        <ManeuverIcon color={primaryText} maneuver={maneuver} size={50} strokeWidth={1.7} />
        <View style={styles.copy}>
          {offRoute ? (
            <Text numberOfLines={1} style={[styles.offRouteTitle, { color: primaryText }]}>
              Finding a new way
            </Text>
          ) : (
            <Text numberOfLines={1} style={[styles.distance, { color: primaryText }]}>
              {distance}
            </Text>
          )}
          {/* The instruction stays on the off-route banner rather than being
              replaced. While the new route is being fetched the last one is
              still the best guess available, and a banner that empties itself
              reads as the app having given up. */}
          <Text numberOfLines={1} style={[styles.instruction, { color: secondaryText }]}>
            {instruction}
          </Text>
        </View>
      </View>

      {offRoute ? <RerouteBar color={primaryText} /> : null}

      {!offRoute && then ? (
        <View>
          {/* A tint of the banner's own type colour rather than a token: this
              hairline sits on the banner fill, not on a themed surface, and
              `--border` against #114E45 is invisible. */}
          <View style={[styles.hairline, { backgroundColor: secondaryText }]} />
          <View style={styles.then}>
            <Text style={[styles.thenLabel, { color: secondaryText }]}>Then</Text>
            <ManeuverIcon color={secondaryText} maneuver={then.maneuver} size={19} />
            <Text numberOfLines={1} style={[styles.thenText, { color: secondaryText }]}>
              {then.text}
            </Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

/**
 * A bar that says work is happening without claiming to know how much is left.
 *
 * Indeterminate on purpose. A reroute is one round trip to Google whose length
 * nobody can predict from inside the phone, and a progress bar that fills at a
 * guessed rate and then sits at 95% is worse than no bar. This one only says
 * "still going".
 *
 * Driven by `Animated.loop` on the native driver, not by a timer: Android
 * pauses JS timers the moment the screen goes to the background, and a
 * JS-driven bar would also stall exactly when the phone is busy parsing the
 * route it is waiting for. The width is measured rather than assumed because
 * `translateX` on the native driver cannot take a percentage.
 */
function RerouteBar({ color }: { color: string }) {
  const reducedMotion = useReducedMotion();
  const [width, setWidth] = useState(0);
  const slide = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (reducedMotion || width === 0) {
      slide.setValue(0);
      return;
    }
    const animation = Animated.loop(
      Animated.timing(slide, {
        toValue: 1,
        duration: 1_100,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: true,
      }),
    );
    animation.start();
    return () => animation.stop();
  }, [reducedMotion, slide, width]);

  const fill = width * 0.38;

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={styles.rerouteTrack}
    >
      {/* The track is the same colour at low opacity, as its own layer — the
          opacity cannot sit on the parent, or it would take the moving fill
          down with it and there would be nothing to see. */}
      <View style={[StyleSheet.absoluteFill, { backgroundColor: color, opacity: 0.3 }]} />
      {/* Nothing moves when the OS asks for reduced motion. The track still
          draws and the banner still says "Finding a new way", so the state is
          conveyed without anything sliding. */}
      {reducedMotion ? null : (
        <Animated.View
          style={[
            styles.rerouteFill,
            {
              backgroundColor: color,
              width: fill,
              transform: [
                {
                  translateX: slide.interpolate({
                    inputRange: [0, 1],
                    outputRange: [-fill, width],
                  }),
                },
              ],
            },
          ]}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    borderBottomLeftRadius: 22,
    borderBottomRightRadius: 22,
    paddingTop: 52,
    paddingHorizontal: 18,
    paddingBottom: 14,
  },
  main: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  copy: { minWidth: 0, flex: 1 },
  distance: { fontSize: 34, fontWeight: '700', letterSpacing: -0.5 },
  offRouteTitle: { fontSize: 26, fontWeight: '700', letterSpacing: -0.4 },
  instruction: { marginTop: 2, fontSize: 17, fontWeight: '500' },
  hairline: { marginTop: 12, height: StyleSheet.hairlineWidth, opacity: 0.32 },
  then: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 9 },
  thenLabel: { fontSize: 13, fontWeight: '600', opacity: 0.85 },
  thenText: { minWidth: 0, flex: 1, fontSize: 13, fontWeight: '500' },
  rerouteTrack: {
    marginTop: 14,
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
  },
  rerouteFill: { position: 'absolute', top: 0, bottom: 0, borderRadius: 2 },
});
