import { Text, View } from 'react-native';

import { BottomSheet } from '@/src/components/BottomSheet';
import { Button } from '@/src/components/ui';

import { useNavColors } from './nav-colors';

/**
 * They stopped somewhere the app was not expecting.
 *
 * ## The tone is the whole design here
 *
 * The order is a suggestion — `DayRouteSummary` puts it in those words, and
 * nothing records whether it was followed. A technician who goes to stop four
 * first has done nothing wrong and must not be told otherwise by a phone. But
 * the app cannot quietly re-plan around it either: it is still steering to stop
 * two, it will keep announcing stop two, and saying nothing leaves somebody
 * fighting a navigator that has apparently lost track of where they are.
 *
 * So this says both things plainly: nothing is wrong, and here is why you are
 * being asked. The copy is deliberate and was approved as written; it is not a
 * string to tidy up later.
 *
 * ## Why the consequence is spelled out under the button
 *
 * "Do this one now" re-orders the rest of the day from here, which moves the
 * stop the technician was heading for. That is a real change to their
 * afternoon, and finding it out afterwards — from a chain rail that has
 * silently rearranged itself — is how somebody stops trusting the order
 * entirely.
 */
export function OutOfOrderSheet({
  visible,
  stoppedAtPosition,
  expectedPosition,
  propertyName,
  addressLine,
  busy = false,
  onDoThisOne,
  onKeepDriving,
  onClose,
}: {
  visible: boolean;
  /** Where they actually are, 1-based. */
  stoppedAtPosition: number;
  /** Where the app is still steering, 1-based. */
  expectedPosition: number;
  propertyName: string;
  addressLine?: string;
  busy?: boolean;
  onDoThisOne: () => void;
  onKeepDriving: () => void;
  onClose: () => void;
}) {
  const colors = useNavColors();

  return (
    <BottomSheet accessibilityRole="alert" onClose={onClose} visible={visible}>
      <View className="gap-5">
        <View className="gap-3">
          <View className="self-start rounded-full px-3 py-1" style={{ backgroundColor: colors.warningWash }}>
            <Text className="text-xs font-bold" style={{ color: colors.warning }}>
              You stopped at stop {stoppedAtPosition}, not stop {expectedPosition}
            </Text>
          </View>

          <View className="gap-0.5">
            <Text className="text-xl font-bold tracking-tight text-foreground">{propertyName}</Text>
            {addressLine ? (
              <Text className="text-sm text-muted-foreground">{addressLine}</Text>
            ) : null}
          </View>

          <Text className="text-sm leading-5 text-muted-foreground">
            Nothing is wrong. The order was only ever a suggestion — but the app will keep steering
            you to stop {expectedPosition} until you say which one you are actually doing.
          </Text>
        </View>

        <View className="gap-2">
          <View className="gap-1.5">
            <Button busy={busy} busyLabel="Working…" label="Do this one now" onPress={onDoThisOne} />
            <Text className="px-1 text-xs text-muted-foreground">
              The rest of the day re-orders from here — stop {expectedPosition} moves later.
            </Text>
          </View>
          <Button
            disabled={busy}
            label={`Keep driving to stop ${expectedPosition}`}
            onPress={onKeepDriving}
            variant="secondary"
          />
        </View>
      </View>
    </BottomSheet>
  );
}
