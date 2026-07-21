import { router, useLocalSearchParams } from 'expo-router';
import { Text } from 'react-native';

import { AppScreen } from '../../../../src/components/AppScreen';
import { ErrorState, LoadingState } from '../../../../src/components/ScreenStates';
import { AppButton, Card, PropertyVisual } from '../../../../src/components/ui';
import { useProperty } from '../../../../src/features/queries';
import { typography, useAppTheme } from '../../../../src/theme';

export default function PropertyScreen() {
  const { colors } = useAppTheme();
  const { propertyId = '', inspectionId = 'inspection-oak' } = useLocalSearchParams<{
    propertyId: string;
    inspectionId?: string;
  }>();
  const query = useProperty(propertyId);
  if (query.isLoading) return <LoadingState label="Loading property…" />;
  if (!query.data)
    return <ErrorState message="Property unavailable" onRetry={() => void query.refetch()} />;
  return (
    <AppScreen title={query.data.address} subtitle={query.data.cityStateZip}>
      <PropertyVisual tone={query.data.imageTone} />
      <Card>
        <Text style={{ ...typography.label, color: colors.primary }}>PROPERTY NOTES</Text>
        <Text style={{ ...typography.body, color: colors.textPrimary }}>{query.data.notes}</Text>
      </Card>
      <Card>
        <Text style={{ ...typography.label, color: colors.primary }}>EXTERNAL RECORD</Text>
        <Text style={{ ...typography.body, color: colors.textSecondary }}>
          {query.data.externalPropertyId} · Source property data remains externally managed.
        </Text>
      </Card>
      <AppButton
        label="Floor plan and approved rooms"
        onPress={() =>
          router.push({
            pathname: '/(app)/properties/[propertyId]/floor-plan',
            params: { propertyId, inspectionId },
          })
        }
      />
    </AppScreen>
  );
}
