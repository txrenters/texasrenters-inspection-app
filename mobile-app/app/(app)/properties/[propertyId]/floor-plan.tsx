import { useMemo, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { AppScreen } from '../../../../src/components/AppScreen';
import { ErrorState, LoadingState } from '../../../../src/components/ScreenStates';
import { AppButton, FilterChip, StatusBadge } from '../../../../src/components/ui';
import {
  useFloorPlan,
  useInspectionContext,
  useProperty,
} from '../../../../src/features/queries';
import {
  type AppColors,
  radius,
  spacing,
  typography,
  useThemedStyles,
} from '../../../../src/theme';

export default function FloorPlanScreen() {
  const styles = useThemedStyles(createStyles);
  const { propertyId = '', inspectionId = '' } = useLocalSearchParams<{
    propertyId: string;
    inspectionId?: string;
  }>();
  const hasInspection = Boolean(inspectionId);
  const inspectionContext = useInspectionContext(inspectionId);
  const property = useProperty(propertyId, !hasInspection);
  const resolvedProperty = inspectionContext.data?.property ?? property.data;
  const resolvedPropertyId = propertyId || resolvedProperty?.id || '';
  const floorPlan = useFloorPlan(resolvedPropertyId);
  const rooms = inspectionContext.data?.rooms ?? [];
  const floors = useMemo(
    () => [...new Set(rooms.map((room) => room.floorName))],
    [rooms],
  );
  const [selectedFloor, setSelectedFloor] = useState<string | null>(null);
  const [sourceIndex, setSourceIndex] = useState(0);
  const activeFloor = selectedFloor ?? floors[0] ?? '';
  const visibleRooms = useMemo(
    () => rooms.filter((room) => room.floorName === activeFloor),
    [activeFloor, rooms],
  );

  const contextQuery = hasInspection ? inspectionContext : property;

  if (contextQuery.isLoading || floorPlan.isLoading)
    return <LoadingState label="Loading floor plan…" />;
  if (!resolvedProperty || contextQuery.error)
    return (
      <ErrorState
        message={contextQuery.error?.message ?? 'The assigned property could not be loaded.'}
        onRetry={() => void contextQuery.refetch()}
      />
    );

  const plan = floorPlan.data;
  const imageSource = plan?.contentSources[sourceIndex];
  const isImage = plan?.mimeType.startsWith('image/');
  const planUnavailable = !plan || floorPlan.isError || (isImage && !imageSource);

  return (
    <AppScreen title="Floor plan" subtitle={`${resolvedProperty.address} · Approved property areas`}>
      <View style={styles.floorTabs}>
        {floors.map((floor) => (
          <FilterChip
            key={floor}
            label={floor}
            selected={activeFloor === floor}
            onPress={() => setSelectedFloor(floor)}
          />
        ))}
      </View>

      {plan && isImage && imageSource ? (
        <View style={styles.plan}>
          <Image
            accessibilityLabel={`Approved floor plan: ${plan.fileName}`}
            resizeMode="contain"
            source={imageSource}
            style={styles.planImage}
            onError={() => {
              if (sourceIndex + 1 < plan.contentSources.length)
                setSourceIndex((current) => current + 1);
            }}
          />
        </View>
      ) : plan?.mimeType === 'application/pdf' ? (
        <View style={styles.planUnavailable}>
          <View style={styles.infoIcon}>
            <Text style={styles.infoIconText}>i</Text>
          </View>
          <Text style={styles.planUnavailableTitle}>Approved PDF floor plan</Text>
          <Text style={styles.help}>
            {`${plan.fileName} is securely stored. Use the approved area master list below during the inspection.`}
          </Text>
        </View>
      ) : planUnavailable ? (
        <View
          accessible
          accessibilityLabel={
            floorPlan.isError ? 'Floor plan temporarily unavailable' : 'No floor plan available'
          }
          style={styles.planUnavailable}
        >
          <View style={styles.infoIcon}>
            <Text style={styles.infoIconText}>i</Text>
          </View>
          <Text style={styles.planUnavailableTitle}>
            {floorPlan.isError ? 'Floor plan temporarily unavailable' : 'No floor plan available'}
          </Text>
          <Text style={styles.help}>
            {floorPlan.isError
              ? 'The floor plan could not be loaded right now. You can continue with the approved room list or try again.'
              : 'There is no approved floor plan available for this property. Contact your administrator to upload and approve one.'}
          </Text>
          {floorPlan.isError ? (
            <AppButton
              label="Try floor plan again"
              variant="outline"
              compact
              onPress={() => void floorPlan.refetch()}
            />
          ) : null}
        </View>
      ) : null}

      <Text style={styles.help}>Only administrator-approved areas appear in this workflow.</Text>
      <View style={styles.roomTags}>
        {visibleRooms.map((room) => (
          <Pressable
            key={room.id}
            accessibilityRole="button"
            onPress={() =>
              router.push({
                pathname: '/(app)/inspections/[inspectionId]/area/[areaId]',
                params: { inspectionId, areaId: room.id },
              })
            }
            style={styles.roomTag}
          >
            <View style={styles.flex}>
              <Text style={styles.roomName}>{room.name}</Text>
              <Text style={styles.roomMeta}>{room.isRequired ? 'Required' : 'Optional'}</Text>
            </View>
            <StatusBadge label={room.completionStatus} />
          </Pressable>
        ))}
      </View>
    </AppScreen>
  );
}

const createStyles = (colors: AppColors) =>
  StyleSheet.create({
    floorTabs: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    plan: {
      height: 270,
      padding: spacing.md,
      borderRadius: radius.lg,
      borderWidth: 2,
      borderColor: colors.primary,
      backgroundColor: '#FAFCFB',
    },
    planImage: { width: '100%', height: '100%' },
    planUnavailable: {
      minHeight: 150,
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      padding: spacing.xl,
      borderWidth: 1,
      borderColor: colors.info,
      borderRadius: radius.lg,
      backgroundColor: colors.infoSoft,
    },
    infoIcon: {
      width: 40,
      height: 40,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 20,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.info,
    },
    infoIconText: { color: colors.info, fontSize: 20, fontWeight: '900' },
    planUnavailableTitle: { ...typography.heading, color: colors.textPrimary },
    help: { ...typography.caption, color: colors.textSecondary, textAlign: 'center' },
    roomTags: { gap: spacing.sm },
    roomTag: {
      minHeight: 64,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      padding: spacing.md,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.md,
      backgroundColor: colors.surface,
    },
    flex: { flex: 1 },
    roomName: { ...typography.heading, color: colors.textPrimary },
    roomMeta: { ...typography.caption, color: colors.textSecondary },
  });
