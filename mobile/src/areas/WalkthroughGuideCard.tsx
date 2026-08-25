import { RotateCwIcon } from 'lucide-react-native';
import { Text, View } from 'react-native';

import { registerIcons } from '../lib/icons';

registerIcons(RotateCwIcon);

/**
 * How to film this area, shown only before there is anything filmed.
 *
 * It used to render on every visit to every area, above the evidence and the
 * findings, so a technician returning to a room they had already walked read
 * four steps of instructions before reaching anything about the room. The
 * content is unchanged — it is the only place this copy exists — but the area
 * screen now drops it once a recording lands.
 *
 * The two step lists are different jobs, not two wordings of one. A room is
 * filmed in a slow clockwise pass; an air conditioner is filmed standing at the
 * unit, so its steps are places on the equipment rather than points on a
 * circle.
 */
const ROOM_STEPS = [
  ['1', 'Room overview', 'Capture the full room and primary circulation path'],
  ['2', 'Walls & surfaces', 'Move clockwise and narrate visible conditions'],
  ['3', 'Fixtures & details', 'Pause briefly on appliances, doors, and windows'],
  ['4', 'Exit pass', 'Confirm the room name before ending the recording'],
] as const;

const EQUIPMENT_STEPS = [
  ['1', 'Indoor unit', 'Film the head unit, its filter and the coil behind it'],
  ['2', 'Drain and tray', 'Show the condensate path and any standing water'],
  ['3', 'Running check', 'Narrate airflow, noise and vibration with it running'],
  ['4', 'Outdoor unit', 'Capture the condenser and the refrigerant lines'],
] as const;

export function WalkthroughGuideCard({ isEquipmentVisit }: { isEquipmentVisit: boolean }) {
  const steps = isEquipmentVisit ? EQUIPMENT_STEPS : ROOM_STEPS;

  return (
    <View className="mx-5 mt-4 rounded-2xl bg-card p-5">
      <View className="flex-row items-start gap-3">
        <View className="h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
          <RotateCwIcon size={19} className="text-primary" />
        </View>
        <View className="min-w-0 flex-1">
          <Text className="text-base font-semibold text-foreground">
            {isEquipmentVisit ? 'Equipment Walkthrough' : 'Clockwise Walkthrough'}
          </Text>
          <Text className="mt-1 text-xs leading-5 text-muted-foreground">
            {isEquipmentVisit
              ? 'Cover the unit itself. There is no room sweep to complete: film what you are working on and narrate what you find.'
              : 'Narrate one slow pass around the room. Use snapshots to document the overview and focused finding context without interrupting the video.'}
          </Text>
        </View>
      </View>
      <View className="mt-4 overflow-hidden rounded-xl bg-muted">
        {steps.map(([number, title, description], index) => (
          <View
            key={number}
            className={`flex-row items-center gap-3 px-3 py-3 ${
              index === steps.length - 1 ? '' : 'border-b border-border'
            }`}
          >
            <View className="h-7 w-7 items-center justify-center rounded-full bg-primary/10">
              <Text className="text-xs font-bold text-primary">{number}</Text>
            </View>
            <View className="min-w-0 flex-1">
              <Text className="text-sm font-semibold text-foreground">{title}</Text>
              <Text className="mt-0.5 text-xs text-muted-foreground">{description}</Text>
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}
