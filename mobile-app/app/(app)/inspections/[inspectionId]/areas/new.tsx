import { useMemo, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { KeyboardAwareFormScreen } from '../../../../../src/components/ScreenPrimitives';
import { AppButton, FilterChip } from '../../../../../src/components/ui';
import { Input } from '../../../../../src/components/ui/input';
import { Textarea } from '../../../../../src/components/ui/textarea';
import type { AreaEnvironment } from '../../../../../src/domain/models';
import { useAddArea } from '../../../../../src/features/queries';
import {
  type AppColors,
  spacing,
  typography,
  useAppTheme,
  useThemedStyles,
} from '../../../../../src/theme';
import { AREA_CATEGORIES, AREA_ENVIRONMENTS } from '../../../../../src/utils/area-taxonomy';

export default function AddInspectionAreaScreen() {
  const { inspectionId = '' } = useLocalSearchParams<{ inspectionId: string }>();
  const { colors } = useAppTheme();
  const styles = useThemedStyles(createStyles);
  const addArea = useAddArea(inspectionId);
  const [name, setName] = useState('');
  const [environment, setEnvironment] = useState<AreaEnvironment>('INDOOR');
  const [category, setCategory] = useState<string | null>(null);
  const [floorName, setFloorName] = useState('');
  const [notes, setNotes] = useState('');
  const categories = useMemo(
    () => AREA_CATEGORIES.filter((option) => option.environment === environment),
    [environment],
  );

  const save = async () => {
    if (!name.trim() || addArea.isPending) return;
    try {
      await addArea.mutateAsync({
        name: name.trim(),
        environment,
        category: category ?? undefined,
        floorName: floorName.trim() || undefined,
        notes: notes.trim() || undefined,
      });
      router.back();
    } catch {
      // The mutation error is rendered inline and the entered form remains intact.
    }
  };

  return (
    <KeyboardAwareFormScreen
      title="Add missing area"
      subtitle="This area is submitted as a draft for administrator review."
      bottomAction={
        <AppButton
          label={addArea.isPending ? 'Adding area…' : 'Add area'}
          loading={addArea.isPending}
          disabled={!name.trim()}
          onPress={() => void save()}
        />
      }
    >
      <Field label="Area name">
        <Input
          accessibilityLabel="Area name"
          className="h-12"
          value={name}
          onChangeText={setName}
          placeholder="e.g. Back patio or perimeter fence"
          placeholderTextColor={colors.textSecondary}
          autoFocus
          returnKeyType="next"
        />
      </Field>

      <Field label="Location">
        <View style={styles.chips}>
          {AREA_ENVIRONMENTS.map((option) => (
            <FilterChip
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
      </Field>

      <Field label="Category">
        <View style={styles.chips}>
          {categories.map((option) => (
            <FilterChip
              key={option.value}
              label={option.label}
              selected={category === option.value}
              onPress={() => setCategory(category === option.value ? null : option.value)}
            />
          ))}
        </View>
      </Field>

      <Field label="Floor or level" optional>
        <Input
          accessibilityLabel="Floor or level"
          className="h-12"
          value={floorName}
          onChangeText={setFloorName}
          placeholder="e.g. Exterior or second floor"
          placeholderTextColor={colors.textSecondary}
        />
      </Field>

      <Field label="Notes" optional>
        <Textarea
          accessibilityLabel="Reason this area was added"
          className="min-h-28"
          value={notes}
          onChangeText={setNotes}
          placeholder="Why this area was added"
          placeholderTextColor={colors.textSecondary}
        />
      </Field>

      {addArea.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {(addArea.error as Error).message}
        </Text>
      ) : null}
    </KeyboardAwareFormScreen>
  );
}

function Field({
  label,
  optional,
  children,
}: {
  label: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.field}>
      <Text style={styles.label}>
        {label}
        {optional ? <Text style={styles.optional}> · Optional</Text> : null}
      </Text>
      {children}
    </View>
  );
}

const createStyles = (colors: AppColors) =>
  StyleSheet.create({
    field: { gap: spacing.sm },
    label: { ...typography.label, color: colors.textPrimary },
    optional: { ...typography.caption, color: colors.textSecondary },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    error: {
      ...typography.caption,
      color: colors.danger,
      borderRadius: 10,
      backgroundColor: colors.dangerSoft,
      padding: spacing.md,
    },
  });
