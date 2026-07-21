import { useEffect } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { Text } from 'react-native';

import { AppScreen } from '../../../../../../src/components/AppScreen';
import { ProcessingTimeline } from '../../../../../../src/components/FeatureCards';
import { AppButton, Card } from '../../../../../../src/components/ui';
import { useUploadActions, useUploads } from '../../../../../../src/features/queries';
import { repositories } from '../../../../../../src/repositories';
import { typography, useAppTheme } from '../../../../../../src/theme';

export default function ProcessingStatusScreen() {
  const { colors } = useAppTheme();
  const { inspectionId = '', areaId = '' } = useLocalSearchParams<{
    inspectionId: string;
    areaId: string;
  }>();
  const uploads = useUploads();
  const actions = useUploadActions();
  const item = uploads.data?.find((upload) => upload.roomId === areaId);
  useEffect(() => {
    const timer = setInterval(() => {
      void repositories.uploads.tick().then(() => uploads.refetch());
    }, 800);
    return () => clearInterval(timer);
  }, [uploads]);
  return (
    <AppScreen
      title="Processing status"
      subtitle={item ? `${item.roomName} · ${item.propertyAddress}` : 'Room media'}
    >
      {item ? (
        <ProcessingTimeline status={item.processingStatus} progress={item.processingProgress} />
      ) : (
        <Card>
          <Text style={{ ...typography.body, color: colors.textSecondary }}>
            No queued media is available for this room.
          </Text>
        </Card>
      )}
      {item?.processingStatus === 'FAILED' ? (
        <AppButton
          label="Retry processing"
          onPress={() => actions.retryProcessing.mutate(item.id)}
        />
      ) : null}
      {item?.processingStatus === 'READY_FOR_REVIEW' ? (
        <AppButton
          label="Review findings"
          onPress={() =>
            router.push({
              pathname: '/(app)/inspections/[inspectionId]/findings',
              params: { inspectionId },
            })
          }
        />
      ) : null}
    </AppScreen>
  );
}
