import { Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import { BottomSheet } from '@/src/components/BottomSheet';
import { Button } from '@/src/components/ui';

import { navDuration, navMiles, useNavColors } from './nav-colors';

/**
 * The job is finished. The next drive is about to start on its own.
 *
 * ## Why there is a countdown rather than a button
 *
 * A technician finishing a job has their hands full of phone, lockbox and
 * paperwork, and the one thing they reliably do next is drive to the next stop.
 * Making them ask for that is a press for every stop of every day. But starting
 * silently is worse — the phone would begin speaking directions while they are
 * still writing up the last room — so it announces itself and gives them a few
 * seconds to say no.
 *
 * ## Why this component does not own the countdown
 *
 * `secondsLeft` is a prop, not a timer. Android pauses JS timers when the app
 * goes to the background, which is exactly where the phone is while somebody
 * carries it back to the van — a `setInterval` here would freeze at "8" and
 * resume whenever the screen woke, and the drive would start minutes late or
 * not at all. The engine counts from timestamps; this draws what it is given.
 */
export function ResumeSheet({
  visible,
  endedAtLabel,
  onSiteMinutes,
  secondsLeft,
  totalSeconds,
  position,
  total,
  addressLine,
  city,
  driveSeconds,
  driveMeters,
  arriveLabel,
  onGoNow,
  onHold,
  onChooseDifferent,
  onClose,
}: {
  visible: boolean;
  /** When the job that just finished ended — "4:12 PM". */
  endedAtLabel: string;
  onSiteMinutes: number;
  /** Counted down by the caller, from timestamps rather than from a timer. */
  secondsLeft: number;
  totalSeconds: number;
  /** 1-based, the stop about to be driven to. */
  position: number;
  total: number;
  addressLine: string;
  city: string;
  driveSeconds: number;
  driveMeters: number;
  /** Clock time of arrival — "1:10 PM". */
  arriveLabel: string;
  onGoNow: () => void;
  /** Stops the countdown and leaves the technician where they are. */
  onHold: () => void;
  onChooseDifferent: () => void;
  onClose: () => void;
}) {
  const colors = useNavColors();
  const seconds = Math.max(0, Math.round(secondsLeft));

  return (
    <BottomSheet accessibilityRole="alert" onClose={onClose} visible={visible}>
      <View className="gap-5">
        <Text className="text-sm text-muted-foreground">
          Job ended at {endedAtLabel} · {navDuration(onSiteMinutes * 60)} on site
        </Text>

        <View className="flex-row items-center gap-4">
          <CountdownRing
            secondsLeft={seconds}
            totalSeconds={totalSeconds}
            textColor={colors.text}
            trackColor={colors.hairline}
            tint={colors.routeActive}
          />
          <View className="min-w-0 flex-1 gap-1">
            <Text
              className="text-2xs font-bold uppercase tracking-wider"
              style={{ color: colors.washText }}
            >
              Driving to stop {position} of {total}
            </Text>
            <Text
              className="font-bold tracking-tight text-foreground"
              numberOfLines={2}
              style={{ fontSize: 22 }}
            >
              {addressLine}
            </Text>
            <Text className="text-sm text-muted-foreground">
              {city} · {navDuration(driveSeconds)} · {navMiles(driveMeters)} · arrive{' '}
              {arriveLabel}
            </Text>
          </View>
        </View>

        {/* Two to one. "Go now" is what almost every press will be, and "Hold"
            has to be reachable without being the thing a thumb lands on by
            accident on the way to it. */}
        <View className="flex-row gap-2">
          <Button className="flex-[2]" label="Go now" onPress={onGoNow} />
          <Button className="flex-1" label="Hold" onPress={onHold} variant="secondary" />
        </View>

        <Button label="Drive a different stop instead" onPress={onChooseDifferent} variant="quiet" />
      </View>
    </BottomSheet>
  );
}

/**
 * A ring that empties as the seconds go.
 *
 * Drawn from the props on every render rather than animated: the caller hands
 * this a new `secondsLeft` roughly once a second, so an animation would be
 * interpolating between two values that are about to be replaced anyway, and
 * it would need a driver that survives the app being backgrounded — which is
 * the one thing a countdown on this screen cannot rely on.
 *
 * The number stays readable at every value: a ring alone cannot be read at a
 * glance from four feet away, which is where the phone is when it is sitting
 * on a passenger seat.
 */
function CountdownRing({
  secondsLeft,
  totalSeconds,
  tint,
  trackColor,
  textColor,
}: {
  secondsLeft: number;
  totalSeconds: number;
  tint: string;
  trackColor: string;
  textColor: string;
}) {
  const size = 52;
  const stroke = 4;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  // A zero total would divide by zero and draw a full ring for a countdown that
  // is already over; an empty ring is the honest picture of "no time left".
  const remaining = totalSeconds > 0 ? Math.min(1, Math.max(0, secondsLeft / totalSeconds)) : 0;

  return (
    <View
      accessible
      accessibilityLabel={`${secondsLeft} seconds until the drive starts`}
      accessibilityRole="timer"
      style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}
    >
      <Svg height={size} style={{ position: 'absolute' }} width={size}>
        <Circle
          cx={size / 2}
          cy={size / 2}
          fill="none"
          r={radius}
          stroke={trackColor}
          strokeWidth={stroke}
        />
        <Circle
          cx={size / 2}
          cy={size / 2}
          fill="none"
          // Rotated about its own centre so the ring empties from the top,
          // which is where an eye starts. `origin` and `rotation` rather than a
          // transform string: react-native-svg honours both, and this pair is
          // what `GuidedCaptureOverlay` already uses for the same shape.
          origin={`${size / 2},${size / 2}`}
          r={radius}
          rotation={-90}
          stroke={tint}
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset={circumference * (1 - remaining)}
          strokeLinecap="round"
          strokeWidth={stroke}
        />
      </Svg>
      <Text style={{ color: textColor, fontSize: 17, fontWeight: '700' }}>{secondsLeft}</Text>
    </View>
  );
}
