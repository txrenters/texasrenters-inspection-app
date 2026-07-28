import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { AppScreen } from '../../../../src/components/AppScreen';
import { inspectionProgress, RoomCard } from '../../../../src/components/FeatureCards';
import { EmptyState, ErrorState, LoadingState } from '../../../../src/components/ScreenStates';
import { AppButton, Card, ProgressBar } from '../../../../src/components/ui';
import { useAddArea, useRooms } from '../../../../src/features/queries';
import { type AppColors, radius, spacing, typography, useAppTheme, useThemedStyles } from '../../../../src/theme';
import type { AreaEnvironment } from '../../../../src/domain/models';
import {
  AREA_CATEGORIES,
  AREA_ENVIRONMENTS,
  groupRoomsBySection,
} from '../../../../src/utils/area-taxonomy';
import { nextInspectionRoom } from '../../../../src/utils/room-workflow';

export default function InspectionAreasScreen() {
  const styles = useThemedStyles(createStyles);
  const { inspectionId = '' } = useLocalSearchParams<{ inspectionId: string }>();
  const query = useRooms(inspectionId);
  const [adding, setAdding] = useState(false);

  if (query.isLoading) return <LoadingState label="Loading areas…" />;
  if (query.isError)
    return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;
  const roomList = query.data ?? [];
  const sections = groupRoomsBySection(roomList);
  const progress = inspectionProgress(roomList);
  const nextRoom = nextInspectionRoom(roomList);
  const sequence = new Map(roomList.map((room, index) => [room.id, index + 1]));
  const openRoom = (roomId: string) =>
    router.push({
      pathname: '/(app)/inspections/[inspectionId]/area/[areaId]',
      params: { inspectionId, areaId: roomId },
    });

  return (
    <AppScreen
      title="Inspection areas"
      subtitle="Indoor, outdoor, and areas you add on site"
      refresh={{ onRefresh: () => query.refetch() }}
      bottomAction={
        nextRoom ? (
          <AppButton label={`Continue with ${nextRoom.name}`} onPress={() => openRoom(nextRoom.id)} />
        ) : undefined
      }
    >
      <Card muted>
        <Text style={styles.progressTitle}>
          {progress.completed} of {progress.total} required areas completed
        </Text>
        <ProgressBar value={progress.value} />
        <Text style={styles.progressHelp}>
          Work through indoor and outdoor areas. Add any missing or outdoor area you find on site — an
          administrator approves added areas.
        </Text>
      </Card>

      <AppButton label="+ Add area" variant="outline" onPress={() => setAdding(true)} />

      {roomList.length ? (
        sections.map((section) => (
          <View key={section.key} style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>{section.label}</Text>
              <Text style={styles.sectionCount}>
                {section.rooms.length} area{section.rooms.length === 1 ? '' : 's'}
              </Text>
            </View>
            {section.key === 'MANUAL' ? (
              <Text style={styles.sectionNote}>Added on site — awaiting administrator approval.</Text>
            ) : null}
            <View style={styles.sectionRooms}>
              {section.rooms.map((room) => (
                <RoomCard
                  key={room.id}
                  room={room}
                  sequenceNumber={sequence.get(room.id)}
                  isUpNext={room.id === nextRoom?.id}
                  onPress={() => openRoom(room.id)}
                />
              ))}
            </View>
          </View>
        ))
      ) : (
        <EmptyState
          title="No areas yet"
          message="An administrator must approve extracted areas, or you can add one with “Add area”."
        />
      )}

      <AddAreaModal
        visible={adding}
        inspectionId={inspectionId}
        onClose={() => setAdding(false)}
        onAdded={() => {
          setAdding(false);
          void query.refetch();
        }}
      />
    </AppScreen>
  );
}

function AddAreaModal({
  visible,
  inspectionId,
  onClose,
  onAdded,
}: {
  visible: boolean;
  inspectionId: string;
  onClose: () => void;
  onAdded: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
  const addArea = useAddArea(inspectionId);
  const [name, setName] = useState('');
  const [environment, setEnvironment] = useState<AreaEnvironment>('INDOOR');
  const [category, setCategory] = useState<string | null>(null);
  const [floorName, setFloorName] = useState('');
  const [notes, setNotes] = useState('');

  const reset = () => {
    setName('');
    setEnvironment('INDOOR');
    setCategory(null);
    setFloorName('');
    setNotes('');
  };

  // Categories relevant to the chosen environment, so the picker stays focused.
  const categories = useMemo(
    () => AREA_CATEGORIES.filter((option) => option.environment === environment),
    [environment],
  );

  async function save() {
    if (!name.trim()) return;
    try {
      await addArea.mutateAsync({
        name: name.trim(),
        environment,
        category: category ?? undefined,
        floorName: floorName.trim() || undefined,
        notes: notes.trim() || undefined,
      });
      reset();
      onAdded();
    } catch {
      // Error surfaced below via addArea.error.
    }
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalSheet}>
          <ScrollView contentContainerStyle={styles.modalContent} keyboardShouldPersistTaps="handled">
            <Text style={styles.modalTitle}>Add area</Text>

            <Text style={styles.fieldLabel}>Area name</Text>
            <TextInput
              style={styles.input}
              value={name}
              onChangeText={setName}
              placeholder="e.g. Back patio, Perimeter fence"
              placeholderTextColor={colors.textSecondary}
            />

            <Text style={styles.fieldLabel}>Location</Text>
            <View style={styles.chipRow}>
              {AREA_ENVIRONMENTS.map((option) => (
                <Chip
                  key={option.value}
                  label={option.label}
                  selected={environment === option.value}
                  onPress={() => {
                    setEnvironment(option.value);
                    setCategory(null);
                  }}
                />
              ))}
            </View>

            <Text style={styles.fieldLabel}>Category</Text>
            <View style={styles.chipRow}>
              {categories.map((option) => (
                <Chip
                  key={option.value}
                  label={option.label}
                  selected={category === option.value}
                  onPress={() => setCategory(category === option.value ? null : option.value)}
                />
              ))}
            </View>

            <Text style={styles.fieldLabel}>Floor or level (optional)</Text>
            <TextInput
              style={styles.input}
              value={floorName}
              onChangeText={setFloorName}
              placeholder="e.g. Exterior, Second floor"
              placeholderTextColor={colors.textSecondary}
            />

            <Text style={styles.fieldLabel}>Notes (optional)</Text>
            <TextInput
              style={[styles.input, styles.inputMultiline]}
              value={notes}
              onChangeText={setNotes}
              placeholder="Why this area was added"
              placeholderTextColor={colors.textSecondary}
              multiline
            />

            {addArea.error ? (
              <Text style={styles.modalError}>{(addArea.error as Error).message}</Text>
            ) : null}

            <View style={styles.modalActions}>
              <AppButton label="Cancel" variant="outline" onPress={onClose} />
              <AppButton
                label={addArea.isPending ? 'Adding…' : 'Add area'}
                onPress={() => void save()}
                disabled={!name.trim() || addArea.isPending}
              />
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function Chip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.chip, selected && styles.chipSelected]}
    >
      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text>
    </Pressable>
  );
}

const createStyles = (colors: AppColors) =>
  StyleSheet.create({
    section: { gap: spacing.sm },
    sectionHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
      paddingHorizontal: spacing.xs,
    },
    sectionTitle: { ...typography.heading, color: colors.textPrimary },
    sectionCount: { ...typography.caption, color: colors.textSecondary },
    sectionNote: { ...typography.caption, color: colors.warning, paddingHorizontal: spacing.xs },
    sectionRooms: { gap: spacing.md },
    progressTitle: { ...typography.heading, color: colors.textPrimary },
    progressHelp: { ...typography.caption, color: colors.textSecondary },
    modalBackdrop: {
      flex: 1,
      justifyContent: 'flex-end',
      backgroundColor: 'rgba(0,0,0,0.4)',
    },
    modalSheet: {
      maxHeight: '90%',
      backgroundColor: colors.surface,
      borderTopLeftRadius: radius.lg,
      borderTopRightRadius: radius.lg,
    },
    modalContent: { padding: spacing.lg, gap: spacing.sm },
    modalTitle: { ...typography.title, color: colors.textPrimary, marginBottom: spacing.xs },
    fieldLabel: {
      ...typography.caption,
      color: colors.textSecondary,
      fontWeight: '800',
      marginTop: spacing.sm,
    },
    input: {
      ...typography.body,
      color: colors.textPrimary,
      backgroundColor: colors.background,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    inputMultiline: { minHeight: 72, textAlignVertical: 'top' },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
    chip: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.round,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
      backgroundColor: colors.background,
    },
    chipSelected: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
    chipText: { ...typography.caption, color: colors.textSecondary },
    chipTextSelected: { color: colors.primary, fontWeight: '800' },
    modalError: { ...typography.caption, color: colors.danger, marginTop: spacing.xs },
    modalActions: {
      flexDirection: 'row',
      gap: spacing.sm,
      marginTop: spacing.md,
    },
  });
