import { Text, View } from 'react-native';

import { BottomSheet } from '@/src/components/BottomSheet';
import { Button } from '@/src/components/ui';

import { navDuration, navMiles, useNavColors } from './nav-colors';

/**
 * You are here. Do you want to start the job?
 *
 * ## Why arriving does not start the job
 *
 * The start is the server's stamp and the office reads how long a job took from
 * it, so it waits for the technician's own tap on Start job. Arrival is a guess made from a GPS fix: good enough to open this
 * sheet, nowhere near good enough to begin timing somebody's work. A technician
 * who pulls up outside and spends ten minutes on the phone would otherwise have
 * those ten minutes recorded as inspection time.
 *
 * ## Why "not there yet" is offered
 *
 * `checkArrival` needs sixty metres, a walking pace and six seconds together,
 * which a red light outside the property can produce. That is rare and it is
 * not free to get wrong, so the sheet can be put away and the drive picked up
 * where it was — rather than leaving the technician with a sheet that insists
 * they have arrived somewhere they can see they have not.
 */
export function ArrivalSheet({
  visible,
  position,
  total,
  inspectionType,
  addressLine,
  cityLine,
  droveMeters,
  droveSeconds,
  busy = false,
  onStartJob,
  onNotThereYet,
  onOpenDay,
  onClose,
}: {
  visible: boolean;
  /** 1-based, the stop just reached. */
  position: number;
  total: number;
  /** Already in the office's words — "Move-out inspection". */
  inspectionType: string;
  addressLine: string;
  /** City, state and postcode on one line — "Katy, TX 77494". */
  cityLine: string;
  droveMeters: number;
  droveSeconds: number;
  busy?: boolean;
  onStartJob: () => void;
  /** Puts the sheet away and carries on navigating to the same stop. */
  onNotThereYet: () => void;
  onOpenDay: () => void;
  onClose: () => void;
}) {
  const colors = useNavColors();

  return (
    <BottomSheet accessibilityRole="alert" onClose={onClose} visible={visible}>
      <View className="gap-5">
        <View className="gap-2">
          <View className="flex-row items-center gap-2">
            {/* Not a `Badge`: its tones are drawn from the chart tokens, and
                this chip has to sit in the approved teal alongside the note at
                the bottom of the same sheet. Two different greens on one sheet
                is what the token ramp would have produced here. */}
            <View
              className="rounded-full px-2.5 py-1"
              style={{ backgroundColor: colors.wash }}
            >
              <Text
                className="text-2xs font-bold uppercase tracking-wider"
                style={{ color: colors.washText }}
              >
                Stop {position} of {total}
              </Text>
            </View>
            <Text className="min-w-0 flex-1 text-sm text-muted-foreground" numberOfLines={1}>
              {inspectionType}
            </Text>
          </View>

          <Text className="text-2xl font-bold tracking-tight text-foreground">{addressLine}</Text>
          <Text className="text-sm text-muted-foreground">
            {cityLine} · Drove {navMiles(droveMeters)} in {navDuration(droveSeconds)}
          </Text>
        </View>

        <View className="gap-2">
          {/* 56 rather than the primitive's 48. This is the only control on the
              sheet that does anything irreversible, and it is pressed through a
              van window in the sun with a phone in one hand. */}
          <Button
            busy={busy}
            busyLabel="Starting…"
            className="min-h-14"
            label="Start this job"
            onPress={onStartJob}
          />
          <Button
            disabled={busy}
            label="Not there yet"
            onPress={onNotThereYet}
            variant="secondary"
          />
          <Button
            disabled={busy}
            label="See the rest of the day"
            onPress={onOpenDay}
            variant="secondary"
          />
        </View>

        {/* Said here rather than discovered later. Without it, a technician who
            finishes a job watches the phone start driving somewhere on its own
            and assumes it has done something they did not ask for. */}
        <View className="rounded-xl px-4 py-3" style={{ backgroundColor: colors.wash }}>
          <Text className="text-sm" style={{ color: colors.washText }}>
            When this job ends, the drive to the next stop starts by itself.
          </Text>
        </View>
      </View>
    </BottomSheet>
  );
}
