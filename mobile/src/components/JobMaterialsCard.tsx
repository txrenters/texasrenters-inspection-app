import { ChevronRightIcon } from 'lucide-react-native';
import { Pressable, Text, View } from 'react-native';

import { Card } from '@/src/components/ui';
import { useJobStock, useJobStockLocal } from '@/src/features/queries';
import { registerIcons } from '@/src/lib/icons';
import { materialsLine, showsMaterials, takenForJob } from '@/src/utils/job-stock';

registerIcons(ChevronRightIcon);

/**
 * The job's materials, as one row on the job screen (2026-11-19, phase 7):
 * what has been taken for it so far, opening the Materials screen.
 *
 * Shown only where there is something to show: the office keeps a truck this
 * technician may use, or something was recorded for the job. An office that
 * does not use the inventory never sees it. One small read when the job
 * opens, kept with the job's other data; nothing is asked for again on a
 * timer.
 */
export function JobMaterialsCard({ inspectionId, onOpen, className = '' }: { inspectionId: string; onOpen: () => void; className?: string }) {
  const stock = useJobStock(inspectionId);
  const local = useJobStockLocal(inspectionId);
  const pending = local.data?.pending ?? [];
  const refused = local.data?.refused ?? [];
  if (!showsMaterials(stock.data, pending, refused)) return null;

  return (
    <Card className={`p-0 ${className}`} density="row">
      <Pressable accessibilityHint="Opens what was taken from the truck for this job" accessibilityRole="button" className="flex-row items-center gap-3 p-4 active:opacity-60" onPress={onOpen}>
        <View className="flex-1 gap-1">
          <Text className="text-base font-semibold text-foreground">Materials</Text>
          <Text className="text-sm text-muted-foreground">{materialsLine(takenForJob(stock.data?.taken ?? [], pending), pending.length)}</Text>
          {refused.length ? (
            <Text accessibilityRole="alert" className="text-sm font-semibold text-destructive">
              {refused.length === 1 ? '1 was not recorded. Open to see why.' : `${refused.length} were not recorded. Open to see why.`}
            </Text>
          ) : null}
        </View>
        <ChevronRightIcon className="text-muted-foreground" size={20} />
      </Pressable>
    </Card>
  );
}
