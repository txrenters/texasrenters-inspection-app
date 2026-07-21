import type { Inspection } from '../domain/models';
import { InspectionSummaryCard } from './FeatureCards';

export function ConnectedInspectionCard({
  inspection,
  onPress,
}: {
  inspection: Inspection;
  onPress: () => void;
}) {
  return (
    <InspectionSummaryCard
      inspection={inspection}
      property={inspection.property}
      progress={inspection.progress}
      onPress={onPress}
    />
  );
}
