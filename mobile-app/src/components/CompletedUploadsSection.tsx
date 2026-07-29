import { CheckCircle2, ChevronDown, ChevronRight, CloudOff } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Separator } from '@/components/ui/separator';
import { Text } from '@/components/ui/text';
import type { UploadItem } from '@/domain/models';

/**
 * Finished uploads, collapsed.
 *
 * Previously every completed item rendered the same full-size card as one still
 * in flight, so a day's work pushed the live queue off screen and technicians
 * had to scroll to find what was actually uploading. Done work is history: it
 * collapses to a single summary row and expands to one compact line per item.
 */
export function CompletedUploadsSection({
  items,
  onViewRoom,
}: {
  items: UploadItem[];
  onViewRoom: (item: UploadItem) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  if (!items.length) return null;

  // Uploaded, but the backend may still be transcribing and analysing. FAILED is
  // called out separately — it needs the technician's attention, not a tick.
  const analyzing = items.filter(
    (item) => item.processingStatus !== 'READY_FOR_REVIEW' && item.processingStatus !== 'FAILED',
  );
  const failed = items.filter((item) => item.processingStatus === 'FAILED');

  return (
    <Card className="overflow-hidden p-0">
      <Pressable
        accessibilityHint={expanded ? 'Collapses the list' : 'Expands the list'}
        accessibilityLabel={`Finished uploads, ${items.length} items`}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        // 44pt minimum target.
        className="min-h-[56px] flex-row items-center gap-3 px-4 py-3 active:opacity-70"
        onPress={() => setExpanded((value) => !value)}
      >
        <Icon as={CheckCircle2} className="size-5 text-success" />
        <View className="flex-1">
          <Text className="font-semibold">Finished</Text>
          <Text className="text-sm text-muted-foreground">
            {items.length} uploaded
            {analyzing.length ? ` · ${analyzing.length} analyzing` : ''}
            {failed.length ? ` · ${failed.length} failed` : ''}
          </Text>
        </View>
        <Icon
          as={expanded ? ChevronDown : ChevronRight}
          className="size-5 text-muted-foreground"
        />
      </Pressable>

      {expanded ? (
        <View>
          <Separator />
          {items.map((item, index) => (
            <View key={item.id}>
              {index > 0 ? <Separator /> : null}
              <Pressable
                accessibilityLabel={`${item.roomName}, ${item.propertyAddress}`}
                accessibilityRole="button"
                className="min-h-[56px] flex-row items-center gap-3 px-4 py-3 active:opacity-70"
                onPress={() => onViewRoom(item)}
              >
                <View className="flex-1">
                  <Text className="font-medium" numberOfLines={1}>
                    {item.roomName}
                  </Text>
                  <Text className="text-sm text-muted-foreground" numberOfLines={1}>
                    {item.propertyAddress}
                  </Text>
                </View>
                {item.processingStatus === 'READY_FOR_REVIEW' ? (
                  <Icon as={CheckCircle2} className="size-4 text-success" />
                ) : item.processingStatus === 'FAILED' ? (
                  <Badge variant="destructive">
                    <Text>Failed</Text>
                  </Badge>
                ) : (
                  <Badge variant="secondary">
                    <Text>Analyzing</Text>
                  </Badge>
                )}
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
    </Card>
  );
}

/** Compact offline notice. Replaces a full card that repeated the same message. */
export function OfflineNotice() {
  return (
    <View
      accessibilityRole="alert"
      className="flex-row items-center gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3"
    >
      <Icon as={CloudOff} className="size-5 text-warning" />
      <Text className="flex-1 text-sm">
        Offline — videos stay queued and resume automatically.
      </Text>
    </View>
  );
}
