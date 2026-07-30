import {
  AlertTriangle,
  Check,
  Circle,
  CloudUpload,
  Loader,
  SkipForward,
  Video,
} from 'lucide-react-native';
import type { LucideIcon } from 'lucide-react-native';
import { View } from 'react-native';

import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import type { InspectionRoom } from '@/domain/models';
import { deriveAreaStatus, type AreaStatusDescriptor } from '@/utils/area-status';

const ICONS: Record<AreaStatusDescriptor['icon'], LucideIcon> = {
  circle: Circle,
  video: Video,
  'cloud-upload': CloudUpload,
  loader: Loader,
  'alert-triangle': AlertTriangle,
  check: Check,
  skip: SkipForward,
};

const TONE: Record<AreaStatusDescriptor['tone'], { text: string; surface: string }> = {
  neutral: { text: 'text-muted-foreground', surface: 'bg-muted' },
  info: { text: 'text-info', surface: 'bg-info/10' },
  progress: { text: 'text-uploading', surface: 'bg-uploading/10' },
  success: { text: 'text-success', surface: 'bg-success/10' },
  warning: { text: 'text-warning', surface: 'bg-warning/10' },
  danger: { text: 'text-destructive', surface: 'bg-destructive/10' },
};

/**
 * The single authoritative status for an area.
 *
 * Replaces a row of badges that repeated the same state without saying what to
 * do next. Icon + label + detail means the state is never conveyed by colour
 * alone, which also makes it readable in bright outdoor light.
 */
export function AreaStatusLine({ room }: { room: InspectionRoom }) {
  const status = deriveAreaStatus(room);
  const tone = TONE[status.tone];

  return (
    <View
      accessibilityLabel={`Status: ${status.label}. ${status.detail}`}
      accessibilityRole="text"
      className={`flex-row items-start gap-3 rounded-lg p-3 ${tone.surface}`}
    >
      <Icon as={ICONS[status.icon]} className={`mt-0.5 size-5 ${tone.text}`} />
      <View className="flex-1">
        <Text className={`font-semibold ${tone.text}`}>{status.label}</Text>
        <Text className="text-sm text-muted-foreground">{status.detail}</Text>
      </View>
    </View>
  );
}
