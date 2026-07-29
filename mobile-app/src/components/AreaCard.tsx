import {
  AlertTriangle,
  Check,
  ChevronRight,
  Circle,
  CloudUpload,
  Loader,
  SkipForward,
  Video,
} from 'lucide-react-native';
import type { LucideIcon } from 'lucide-react-native';
import { memo } from 'react';
import { Pressable, View } from 'react-native';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import type { InspectionRoom } from '@/domain/models';
import {
  areaActionLabel,
  deriveAreaStatus,
  type AreaStatusDescriptor,
} from '@/utils/area-status';

const ICONS: Record<AreaStatusDescriptor['icon'], LucideIcon> = {
  circle: Circle,
  video: Video,
  'cloud-upload': CloudUpload,
  loader: Loader,
  'alert-triangle': AlertTriangle,
  check: Check,
  skip: SkipForward,
};

const TONE: Record<AreaStatusDescriptor['tone'], string> = {
  neutral: 'text-muted-foreground',
  info: 'text-info',
  progress: 'text-uploading',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-destructive',
};

/**
 * One area, as one clearly bounded card.
 *
 * Deliberately compact: the earlier layout gave baseline, recording, upload and
 * AI review a full row each, so a single area filled the screen and a technician
 * could not scan the list. Here the derived status collapses all of that into
 * one line plus a counts line.
 */
export const AreaCard = memo(function AreaCard({
  room,
  sequence,
  isUpNext,
  photoCount,
  findingCount = 0,
  onOpen,
  onAction,
}: {
  room: InspectionRoom;
  sequence: number;
  isUpNext: boolean;
  /** Omitted when unknown — showing "0 photos" for an uncounted area is a lie. */
  photoCount?: number;
  findingCount?: number;
  onOpen: () => void;
  onAction: () => void;
}) {
  const status = deriveAreaStatus(room);
  const StatusIcon = ICONS[status.icon];

  return (
    <Card
      // The up-next area is the only one with a ring, so the eye lands on it
      // immediately without every row shouting "NEXT".
      className={isUpNext ? 'border-primary p-0' : 'p-0'}
    >
      <Pressable
        // Label carries sequence, name, requirement and state so VoiceOver
        // announces the whole row rather than the visible fragments.
        accessibilityLabel={[
          `Area ${sequence}`,
          room.name,
          room.floorName,
          room.isRequired ? 'Required' : 'Optional',
          status.label,
          isUpNext ? 'Up next' : '',
        ]
          .filter(Boolean)
          .join(', ')}
        accessibilityRole="button"
        className="min-h-[56px] flex-row items-start gap-3 px-4 pt-3 active:opacity-70"
        onPress={onOpen}
      >
        <View className="mt-0.5 size-7 items-center justify-center rounded-full bg-muted">
          <Text className="text-xs font-semibold text-muted-foreground">{sequence}</Text>
        </View>

        <View className="flex-1 gap-1">
          <View className="flex-row items-center gap-2">
            <Text className="flex-1 font-semibold" numberOfLines={1}>
              {room.name}
            </Text>
            {isUpNext ? (
              <Badge variant="default">
                <Text>Up next</Text>
              </Badge>
            ) : null}
          </View>

          <Text className="text-sm text-muted-foreground" numberOfLines={1}>
            {room.floorName} · {room.isRequired ? 'Required' : 'Optional'}
          </Text>

          {/* Icon + label + detail: status never depends on colour alone. */}
          <View className="flex-row items-center gap-1.5">
            <Icon as={StatusIcon} className={`size-4 ${TONE[status.tone]}`} />
            <Text className={`text-sm font-medium ${TONE[status.tone]}`}>{status.label}</Text>
          </View>
          <Text className="text-xs text-muted-foreground" numberOfLines={2}>
            {status.detail}
          </Text>

          <Text className="text-xs text-muted-foreground">
            {photoCount === undefined
              ? null
              : `${photoCount} photo${photoCount === 1 ? '' : 's'} · `}
            {findingCount} finding{findingCount === 1 ? '' : 's'}
          </Text>
        </View>

        <Icon as={ChevronRight} className="mt-1 size-5 shrink-0 text-muted-foreground" />
      </Pressable>

      <View className="px-4 pb-3 pt-2">
        <Button
          accessibilityLabel={`${areaActionLabel(status.status)} — ${room.name}`}
          className="min-h-11"
          onPress={onAction}
          variant={isUpNext || status.needsAttention ? 'default' : 'secondary'}
        >
          <Text>{areaActionLabel(status.status)}</Text>
        </Button>
      </View>
    </Card>
  );
});
