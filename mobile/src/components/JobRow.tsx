import { router } from 'expo-router';
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  ClipboardListIcon,
  MapPinIcon,
  Settings2Icon,
  UploadCloudIcon,
  XCircleIcon,
} from 'lucide-react-native';
import { Pressable, Text, View } from 'react-native';

import type { Inspection } from '../domain/models';
import { registerIcons } from '../lib/icons';
import {
  INSPECTION_STATUS_TONE_CLASS,
  inspectionStatusPresentation,
  type InspectionStatusTone,
} from '../utils/inspection-status';
import { formatVisitDateAndWindow, formatVisitDay, formatVisitWindow } from '../utils/visit-window';
import { InspectionUrgencyBadge, useInspectionUrgency } from './InspectionUrgencyBadge';
import { PRESS_SURFACE } from './ui';

registerIcons(
  AlertTriangleIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  ClipboardListIcon,
  MapPinIcon,
  Settings2Icon,
  UploadCloudIcon,
  XCircleIcon,
);

// Labels and colours come from utils/inspection-status; only the icon choice is
// local, because the Jobs list is the one place that shows one.
const TONE_ICON: Record<InspectionStatusTone, typeof ClipboardListIcon> = {
  assigned: ClipboardListIcon,
  active: Settings2Icon,
  submitted: UploadCloudIcon,
  review: ClipboardListIcon,
  attention: AlertTriangleIcon,
  done: CheckCircle2Icon,
  closed: XCircleIcon,
};

/**
 * One job in a list: where, what, how far along, and when.
 *
 * `showDay` is off inside a single day, where every row would repeat the date in
 * the heading above it; the booked window is what tells those rows apart. On in
 * search results, History and the jobs still open from earlier days, where the
 * day is the point.
 */
export function JobRow({ item, showDay = true }: { item: Inspection; showDay?: boolean }) {
  const urgency = useInspectionUrgency(item);
  const visitWindow = formatVisitWindow(item);
  const presentation = inspectionStatusPresentation(item.status);
  const tone = INSPECTION_STATUS_TONE_CLASS[presentation.tone];
  const StatusIcon = TONE_ICON[presentation.tone];
  const kind = item.type.replaceAll('_', ' ').toLowerCase();
  return (
    <Pressable
      // Read as one item. Left ungrouped, VoiceOver stops six times per card —
      // address, unit, type, progress, status, date — and a technician swiping
      // through a day's assignments has to hold it all in their head.
      accessibilityLabel={[
        item.property.address,
        item.unitName ?? 'Entire property',
        item.property.cityStateZip,
        kind,
        `${item.progress.completed} of ${item.progress.total} rooms complete`,
        presentation.label,
        // Carried in the row's own label: the badge below sits inside a hidden
        // subtree, so this is the only way it reaches a screen reader.
        urgency?.spoken ?? '',
        formatVisitDateAndWindow(item, formatVisitDay(item.scheduledAt)),
        item.progress.hasFailedUpload ? 'Has a failed upload' : '',
      ]
        .filter(Boolean)
        .join(', ')}
      accessibilityRole="button"
      accessibilityHint="Opens this job"
      className={`mx-5 mb-3 rounded-2xl bg-card p-4 ${PRESS_SURFACE}`}
      onPress={() => router.push(`/inspections/${item.id}`)}
    >
      <View importantForAccessibility="no-hide-descendants" className="flex-row items-start gap-3">
        <View className="mt-0.5 h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
          <MapPinIcon size={18} className="text-primary" />
        </View>
        <View className="min-w-0 flex-1">
          <Text numberOfLines={1} className="text-base font-semibold text-foreground">
            {item.property.address}
          </Text>
          <Text numberOfLines={1} className="mt-0.5 text-sm text-muted-foreground">
            {item.unitName ?? 'Entire property'} · {item.property.cityStateZip}
          </Text>
          <Text numberOfLines={2} className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            {kind} · {item.progress.completed} of {item.progress.total} rooms complete
          </Text>
          <View className="mt-2 flex-row flex-wrap items-center gap-2">
            <View className={`flex-row items-center gap-1 rounded-full px-2.5 py-0.5 ${tone.bg}`}>
              <StatusIcon size={12} className={tone.text} />
              <Text className={`text-xs font-semibold ${tone.text}`}>{presentation.label}</Text>
            </View>
            <InspectionUrgencyBadge inspection={item} />
            {/* `formatVisitDay` reads the date column as the date it is: in the
                phone's own zone it printed Oct 6 in Texas for a visit on Oct 7. */}
            {showDay ? (
              <Text className="text-xs text-muted-foreground">{formatVisitDay(item.scheduledAt)}</Text>
            ) : null}
            {visitWindow ? (
              <Text className="text-xs font-medium text-foreground">{visitWindow}</Text>
            ) : null}
          </View>
        </View>
        <ChevronRightIcon size={18} className="mt-3 text-muted-foreground" />
      </View>
    </Pressable>
  );
}
