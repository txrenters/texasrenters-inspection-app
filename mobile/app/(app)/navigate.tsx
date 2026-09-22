import { useLocalSearchParams, router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useDayRoute, useMapSession } from '@/src/features/queries';
import { goBack } from '@/src/lib/navigation';
import {
  formatArrivalClock,
  formatDistance,
  formatDuration,
  useNavigationSession,
  type NavLegRequest,
} from '@/src/navigation/engine';
import { NavMap, type NavMapLine, type NavMapPin } from '@/src/navigation/map';
import {
  ArrivalSheet,
  ChainRail,
  DayRow,
  ManeuverBanner,
  MapButtons,
  NavHud,
  NoRouteScreen,
  OutOfOrderSheet,
  RecentrePill,
  ResumeSheet,
  SpeedPill,
  StepList,
  useNavColors,
} from '@/src/navigation/ui';
import { repositories } from '@/src/repositories';
import type { NavigationLeg } from '@texasrenters/shared';
import { haversineMeters, measurePath, slicePath, splitPathAtStops } from '@texasrenters/shared';

/**
 * Turn-by-turn navigation for the technician's day.
 *
 * The one screen in this feature that knows about all of it, and deliberately
 * the only one. The engine (`src/navigation/engine`) decides everything and
 * touches no React; the map (`src/navigation/map`) draws what it is handed and
 * decides nothing; the chrome (`src/navigation/ui`) is presentational. This file
 * is the wiring, and it is kept thin on purpose — anything here that starts
 * making a judgement belongs in the engine, where it can be tested without a
 * handset.
 *
 * ## Why it is a sibling of `(tabs)`, not a tab
 *
 * A tab screen keeps the tab bar, which would have to be hidden and restored on
 * every transition; on iOS that bar is absolutely positioned over the content
 * and flashes while it animates. It is also why `useTabBarInset()` must never be
 * called from here — it reads the bottom-tab navigator's height and throws when
 * there is no tab navigator above it, which there is not.
 *
 * ## Why the insets are measured rather than assumed
 *
 * `OfflineBanner` is mounted above the `<Stack>` in normal flow, so the moment
 * NetInfo reports offline it pushes this whole screen down by its height plus
 * the top inset. A hardcoded status-bar padding would then sit the maneuver
 * banner twice as far down as it should. Being offline mid-drive is worth
 * saying, so the banner stays — the screen adapts to it instead.
 */

/** Street-level. The whole day gets its own zoom on the overview. */
const DRIVING_ZOOM = 16.5;

export default function NavigateScreen() {
  const params = useLocalSearchParams<{ to?: string }>();
  const insets = useSafeAreaInsets();
  const nav = useNavColors();

  const dayRoute = useDayRoute();
  const route = dayRoute.data ?? null;

  /**
   * The leg, held here because the engine does not give it back.
   *
   * `useNavigationSession` asks for a leg through `fetchLeg` and keeps only what
   * it needs to steer. The map needs the geometry, so this captures it on the
   * way past rather than making the engine carry a shape it has no use for.
   */
  const [leg, setLeg] = useState<NavigationLeg | null>(null);
  const [stepsOpen, setStepsOpen] = useState(false);
  const [following, setFollowing] = useState(true);
  const [northUp, setNorthUp] = useState(false);
  const [muted, setMuted] = useState(false);
  const [jobEndedAt, setJobEndedAt] = useState<number | null>(null);
  const startedRef = useRef(false);

  const fetchLeg = useCallback(async (request: NavLegRequest) => {
    const from = request.from ? { latitude: request.from[0], longitude: request.from[1] } : null;
    if (!from) return null;
    const next = await repositories.inspections.navigationLeg(request.toStopId, from);
    setLeg(next);
    return next;
  }, []);

  const session = useNavigationSession({
    dayRoute: route,
    fetchLeg,
    // Voice needs `expo-speech`, which is a native module this build may not
    // import — see the note in `announcer.ts`. Announcements are shown instead.
    speak: null,
    onArrived: () => setFollowing(true),
  });

  const { view } = session;

  // Start once the day route has landed, and only once: `start()` resets the
  // session, so calling it on every render would restart the drive on every fix.
  if (!startedRef.current && route && !dayRoute.isLoading) {
    startedRef.current = true;
    session.start(params.to ?? null);
  }

  /**
   * Memoised because `?? []` is a new array on every render.
   *
   * Every memo below depends on it, including the one that thins the polylines
   * — which is the frame rate of the whole screen. An unstable `stops` makes all
   * of them recompute on every fix, which is exactly the cost they exist to
   * avoid, and it does it while the driver is approaching a turn.
   */
  const stops = useMemo(() => route?.stops ?? [], [route?.stops]);
  const targetIndex = stops.findIndex((stop) => stop.inspectionId === view.targetStopId);
  const targetStop = targetIndex >= 0 ? stops[targetIndex] : null;

  const mapSession = useMapSession({
    mapType: 'roadmap',
    theme: nav.isDark ? 'dark' : 'light',
    traffic: true,
  });

  /**
   * The line, cut at the technician.
   *
   * Three pieces, and the order they are drawn in is the order they are listed:
   * the road already behind them in grey, every later leg of the day dotted, and
   * the leg being driven on top of both. The later legs come from the *day*
   * route's geometry, which the backend has always sent and the phone only
   * recently stopped throwing away — this is the connecting chain the office
   * asked for, and it is why the screen can say "then three more stops" rather
   * than going quiet at the destination.
   */
  const lines = useMemo<NavMapLine[]>(() => {
    const out: NavMapLine[] = [];

    if (route?.geometry?.length && targetIndex >= 0) {
      const measured = measurePath(route.geometry);
      const slices = splitPathAtStops(
        measured,
        stops.map((stop) => ({ latitude: stop.latitude, longitude: stop.longitude })),
      );
      // Only what comes AFTER the stop being driven to. The active leg is drawn
      // from the navigation leg below, which is higher-resolution and is the one
      // the driver is actually being steered along.
      for (let index = targetIndex + 1; index < slices.length; index += 1) {
        const slice = slices[index];
        // A stop the day's line never reaches gets an empty slice rather than a
        // wrong one — see `splitPathAtStops`. Skipping it leaves a gap in the
        // chain, which is honest; drawing to it would invent a road.
        if (slice && slice.length >= 2) out.push({ path: slice, kind: 'LATER' });
      }
    }

    if (leg?.polyline?.length) {
      const measured = measurePath(leg.polyline);
      const along = Math.max(0, measured.totalMeters - view.metersRemaining);
      const driven = slicePath(measured, 0, along);
      const ahead = slicePath(measured, along, measured.totalMeters);
      if (driven.length >= 2) out.unshift({ path: driven, kind: 'DRIVEN' });
      if (ahead.length >= 2) out.push({ path: ahead, kind: 'ACTIVE' });
    }

    return out;
  }, [route?.geometry, stops, targetIndex, leg, view.metersRemaining]);

  const pins = useMemo<NavMapPin[]>(
    () =>
      stops.map((stop, index) => ({
        at: [stop.latitude, stop.longitude] as const,
        label: String(index + 1),
        kind:
          index === targetIndex
            ? ('TARGET' as const)
            : index < targetIndex
              ? ('DONE' as const)
              : ('LATER' as const),
      })),
    [stops, targetIndex],
  );

  const centre = view.snapped ?? (targetStop ? ([targetStop.latitude, targetStop.longitude] as const) : null);
  const bearing = northUp ? 0 : (view.headingDegrees ?? 0);

  const chainStops = useMemo(
    () =>
      stops.map((_, index) => ({
        position: index + 1,
        state:
          index === targetIndex
            ? ('CURRENT' as const)
            : index < targetIndex
              ? ('DONE' as const)
              : ('LATER' as const),
      })),
    [stops, targetIndex],
  );

  const chainLegs = useMemo(
    () =>
      stops.slice(0, -1).map((_, index) => ({
        label:
          index === targetIndex - 1 ? formatDuration(view.secondsRemaining) : null,
      })),
    [stops, targetIndex, view.secondsRemaining],
  );

  // The day route could not be drawn at all, or it starts somewhere no road
  // reaches. Both get the designed screen rather than an empty map: on the
  // console this exact condition looked like a quiet day and hid a dead router
  // for months.
  if (view.blocked || (!dayRoute.isLoading && !route?.geometry?.length && !leg)) {
    const origin = route?.origin;
    return (
      <>
        <StatusBar style={nav.isDark ? 'light' : 'dark'} />
        <NoRouteScreen
          lastTriedLabel={formatArrivalClock(dayRoute.dataUpdatedAt || null)}
          onOpenInMaps={() => undefined}
          onRetry={() => void dayRoute.refetch()}
          retrying={dayRoute.isFetching}
          stops={stops.map((stop) => ({
            stopId: stop.inspectionId,
            propertyName: stop.propertyName,
            addressLine: `${stop.addressLine1}, ${stop.city}`,
            distanceMeters: origin
              ? haversineMeters(origin, { latitude: stop.latitude, longitude: stop.longitude })
              : 0,
            bearingDegrees: 0,
          }))}
          unroutable={(route?.unroutable ?? []).map((item) => ({
            propertyName: item.propertyName,
            reason: item.reason ?? null,
          }))}
        />
      </>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: nav.background }}>
      {/* Always light: the maneuver banner behind the status bar is the deep
          teal in both themes, so `auto` would put dark glyphs on it in light
          mode and the clock would vanish. */}
      <StatusBar style="light" />

      <NavMap
        attribution={mapSession.data?.attribution ?? null}
        camera={{
          center: centre ?? [29.7604, -95.3698],
          zoom: DRIVING_ZOOM,
          bearingDegrees: bearing,
        }}
        lines={lines}
        onGesture={() => setFollowing(false)}
        pins={pins}
        puck={centre ? { at: centre, headingDegrees: view.headingDegrees } : null}
        tileHeaders={mapSession.data?.tileHeaders}
        tileUrlTemplate={mapSession.data?.tileUrlTemplate ?? null}
      />

      <View pointerEvents="box-none" style={{ position: 'absolute', top: 0, left: 0, right: 0 }}>
        {view.step ? (
          <ManeuverBanner
            distanceMeters={view.metersToManeuver}
            instruction={view.step.instruction}
            maneuver={view.step.maneuver}
            then={
              view.nextStep
                ? {
                    maneuver: view.nextStep.maneuver,
                    text: `${view.nextStep.instruction} · ${formatDistance(view.nextStep.distanceMeters)}`,
                  }
                : null
            }
            tone={view.phase === 'OFF_ROUTE' || view.phase === 'REROUTING' ? 'OFF_ROUTE' : 'NORMAL'}
          />
        ) : null}
      </View>

      <View
        pointerEvents="box-none"
        style={{ position: 'absolute', right: 12, top: insets.top + 168 }}
      >
        <MapButtons
          headingDegrees={view.headingDegrees}
          muted={muted}
          northUp={northUp}
          onToggleMute={() => setMuted((value) => !value)}
          onToggleOrientation={() => setNorthUp((value) => !value)}
          onToggleOverview={() => setStepsOpen((value) => !value)}
          overviewOpen={stepsOpen}
        />
      </View>

      <View pointerEvents="box-none" style={{ position: 'absolute', bottom: 236, left: 12 }}>
        <SpeedPill speedMetersPerSecond={null} />
      </View>

      {!following ? (
        <View pointerEvents="box-none" style={{ position: 'absolute', bottom: 236, right: 12 }}>
          <RecentrePill onPress={() => setFollowing(true)} />
        </View>
      ) : null}

      <View
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: nav.surface,
          borderTopLeftRadius: 22,
          borderTopRightRadius: 22,
          paddingTop: 9,
          paddingBottom: Math.max(insets.bottom, 18),
        }}
      >
        <ChainRail legs={chainLegs} stops={chainStops} />
        <NavHud
          address={targetStop ? `${targetStop.addressLine1}, ${targetStop.city}` : ''}
          arrivalLabel={formatArrivalClock(view.arrivalEpochMs)}
          onExit={() => {
            session.stop();
            goBack();
          }}
          onToggleSteps={() => setStepsOpen((value) => !value)}
          remainingMeters={view.metersRemaining}
          remainingSeconds={view.secondsRemaining}
          rerouting={view.phase === 'REROUTING'}
          stepsOpen={stepsOpen}
        />
        <DayRow
          finishLabel={formatArrivalClock(view.arrivalEpochMs)}
          onPress={() => setStepsOpen(true)}
          position={targetIndex + 1}
          total={stops.length}
        />
      </View>

      {stepsOpen && leg ? (
        <View style={{ position: 'absolute', top: insets.top + 96, left: 0, right: 0, bottom: 0 }}>
          <StepList
            arrival={{
              position: targetIndex + 1,
              total: stops.length,
              inspectionType: '',
              etaLabel: formatArrivalClock(view.arrivalEpochMs),
              side: null,
            }}
            steps={leg.steps.map((step) => ({
              maneuver: step.maneuver,
              instruction: step.instruction,
              roadName: step.roadName,
              distanceMeters: step.distanceMeters,
            }))}
          />
        </View>
      ) : null}

      <ArrivalSheet
        addressLine={targetStop?.addressLine1 ?? ''}
        cityLine={targetStop?.city ?? ''}
        droveMeters={leg?.distanceMeters ?? 0}
        droveSeconds={leg?.durationSeconds ?? 0}
        inspectionType=""
        onClose={() => undefined}
        onOpenDay={() => setStepsOpen(true)}
        onNotThereYet={() => undefined}
        onStartJob={() => {
          setJobEndedAt(null);
          if (view.targetStopId) router.push(`/job-inspection/${view.targetStopId}`);
        }}
        position={targetIndex + 1}
        total={stops.length}
        visible={view.phase === 'ARRIVED'}
      />

      <ResumeSheet
        addressLine={targetStop?.propertyName ?? ''}
        arriveLabel={formatArrivalClock(view.arrivalEpochMs)}
        city={targetStop?.city ?? ''}
        driveMeters={leg?.distanceMeters ?? 0}
        driveSeconds={leg?.durationSeconds ?? 0}
        endedAtLabel={formatArrivalClock(jobEndedAt)}
        onChooseDifferent={() => setStepsOpen(true)}
        onClose={() => undefined}
        onGoNow={() => session.nextStop()}
        onHold={() => session.stop()}
        onSiteMinutes={0}
        position={targetIndex + 1}
        secondsLeft={Math.max(
          0,
          Math.round(((view.advanceAtEpochMs ?? 0) - Date.now()) / 1000),
        )}
        total={stops.length}
        totalSeconds={15}
        visible={view.phase === 'ADVANCING'}
      />

      <OutOfOrderSheet
        expectedPosition={targetIndex + 1}
        onClose={() => undefined}
        onDoThisOne={() => session.start(view.unplannedArrivalStopId)}
        onKeepDriving={() => undefined}
        propertyName={
          stops.find((stop) => stop.inspectionId === view.unplannedArrivalStopId)?.propertyName ??
          ''
        }
        stoppedAtPosition={
          stops.findIndex((stop) => stop.inspectionId === view.unplannedArrivalStopId) + 1
        }
        visible={Boolean(view.unplannedArrivalStopId)}
      />
    </View>
  );
}
