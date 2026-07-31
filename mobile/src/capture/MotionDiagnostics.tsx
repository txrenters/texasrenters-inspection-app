import { useEffect, useRef, useState } from 'react';
import { DeviceMotion } from 'expo-sensors';
import { Platform, Pressable, Text, View } from 'react-native';

import { normalizeHeading, radiansOrDegreesToDegrees } from './guided-capture';

type Reading = {
  /** What `isAvailableAsync()` claims — on Android it demands five sensors. */
  reportedAvailable: boolean | null;
  permission: string;
  /** Events delivered at all, whether or not they carried orientation. */
  events: number;
  /** Events that actually carried a `rotation` block. */
  rotationSamples: number;
  headingDegrees: number | null;
  keys: string;
  error: string | null;
};

const EMPTY: Reading = {
  reportedAvailable: null,
  permission: 'not asked',
  events: 0,
  rotationSamples: 0,
  headingDegrees: null,
  keys: '—',
  error: null,
};

/**
 * Live DeviceMotion readout, so a sensor fault can be read off the device
 * instead of guessed at.
 *
 * The 360° guide failed on Android through three separate causes — an unrelated
 * runtime permission, an icon font, and a capability check that demands five
 * sensors when only one is used. Each looked identical from the outside: a
 * guide that did not move. This distinguishes them: whether events arrive at
 * all, whether they carry `rotation`, and what heading comes out.
 */
export function MotionDiagnostics() {
  const [reading, setReading] = useState<Reading>(EMPTY);
  const [listening, setListening] = useState(false);
  const counts = useRef({ events: 0, rotationSamples: 0 });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const reportedAvailable = await DeviceMotion.isAvailableAsync();
        const permission = await DeviceMotion.getPermissionsAsync()
          .then((value) => value.status)
          .catch(() => 'unavailable');
        if (!cancelled) setReading((current) => ({ ...current, reportedAvailable, permission }));
      } catch (error) {
        if (!cancelled)
          setReading((current) => ({
            ...current,
            error: error instanceof Error ? error.message : String(error),
          }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!listening) return;
    counts.current = { events: 0, rotationSamples: 0 };
    DeviceMotion.setUpdateInterval(Platform.OS === 'android' ? 200 : 75);
    const subscription = DeviceMotion.addListener((measurement) => {
      counts.current.events += 1;
      const rotation = measurement.rotation;
      if (rotation) counts.current.rotationSamples += 1;
      setReading((current) => ({
        ...current,
        events: counts.current.events,
        rotationSamples: counts.current.rotationSamples,
        headingDegrees: rotation
          ? normalizeHeading(radiansOrDegreesToDegrees(rotation.alpha))
          : current.headingDegrees,
        // Which blocks the platform actually sends. A device missing gravity or
        // linear acceleration still reports rotation, which is all the guide needs.
        keys: Object.keys(measurement).sort().join(', ') || '(empty)',
      }));
    });
    return () => subscription.remove();
  }, [listening]);

  const verdict = !listening
    ? 'Not started'
    : reading.rotationSamples > 0
      ? 'Working — rotation is being delivered'
      : reading.events > 0
        ? 'Events arriving, but none carry rotation — no rotation-vector sensor'
        : 'No events at all — the listener is not receiving anything';

  return (
    <View className="mx-5 mt-4 rounded-2xl bg-card p-5">
      <Text className="text-base font-bold text-foreground">Motion sensor</Text>
      <Text className="mt-1 text-xs leading-5 text-muted-foreground">
        Move the phone in a slow circle while this runs. The 360° capture guide uses only the
        rotation reading.
      </Text>

      <View className="mt-4 gap-2">
        <Row label="Verdict" value={verdict} />
        <Row
          label="isAvailableAsync"
          value={
            reading.reportedAvailable === null
              ? 'checking…'
              : reading.reportedAvailable
                ? 'true'
                : 'false (Android requires all five motion sensors)'
          }
        />
        <Row label="Permission" value={reading.permission} />
        <Row label="Events received" value={String(reading.events)} />
        <Row label="With rotation" value={String(reading.rotationSamples)} />
        <Row
          label="Heading"
          value={
            reading.headingDegrees === null ? '—' : `${Math.round(reading.headingDegrees)}°`
          }
        />
        <Row label="Payload keys" value={reading.keys} />
        {reading.error ? <Row label="Error" value={reading.error} /> : null}
      </View>

      <Pressable
        accessibilityLabel={listening ? 'Stop motion test' : 'Start motion test'}
        accessibilityRole="button"
        className={`mt-4 min-h-12 items-center justify-center rounded-xl ${
          listening ? 'border border-border' : 'bg-primary'
        }`}
        onPress={() => setListening((value) => !value)}
      >
        <Text className={`font-bold ${listening ? 'text-foreground' : 'text-primary-foreground'}`}>
          {listening ? 'Stop test' : 'Start motion test'}
        </Text>
      </Pressable>
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row items-start justify-between gap-3">
      <Text className="text-xs text-muted-foreground">{label}</Text>
      <Text className="min-w-0 flex-1 text-right text-xs font-semibold text-foreground">
        {value}
      </Text>
    </View>
  );
}
