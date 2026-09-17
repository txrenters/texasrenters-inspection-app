import { router, useLocalSearchParams } from 'expo-router';
import {
  CameraIcon,
  CheckCircle2Icon,
  CircleIcon,
  PlusIcon,
  Trash2Icon,
  XCircleIcon,
} from 'lucide-react-native';
import { useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FILTER_SIZE_PATTERN, normalizeFilterSize } from '@texasrenters/shared';

import { BottomSheet } from '@/src/components/BottomSheet';
import { HomeButton } from '@/src/components/HomeButton';
import { ServiceAnswerSheet } from '@/src/components/ServiceAnswerSheet';
import { Button, Card, Loader } from '@/src/components/ui';
import { BackGlyph } from '@/src/components/ui/BackGlyph';
import { DetailSkeleton } from '@/src/components/ui/Skeleton';
import { useInspection, useInspectionActions } from '@/src/features/queries';
import { registerIcons } from '@/src/lib/icons';
import { goBack } from '@/src/lib/navigation';
import { useThemeColors } from '@/src/lib/theme-colors';
import {
  filterRows,
  withFilterAnswer,
  withServiceAnswer,
  withoutFilter,
  type FilterRow,
} from '@/src/utils/job-tasks';

registerIcons(CameraIcon, CheckCircle2Icon, CircleIcon, PlusIcon, Trash2Icon, XCircleIcon);

/**
 * The job's filter registers, one photograph each.
 *
 * Moses, through the office (2026-09-18): a photograph of every filter, showing
 * the size printed on it. One picture of "the filter change" says nothing about
 * the second register in a house with two, and the office has been reading
 * "Filter Change: done" over registers nobody could reach.
 *
 * The registers come from what the coordinator listed on the visit, expanded by
 * quantity. A register found on site that the visit never listed can be added,
 * because the office would rather know than have it left out.
 */

/** Why a register was not changed. Required, because the office acts on it. */
function NotChangedSheet({
  row,
  onClose,
  onSave,
}: {
  row: FilterRow | null;
  onClose: () => void;
  onSave: (reason: string) => void;
}) {
  const theme = useThemeColors();
  const [reason, setReason] = useState('');

  return (
    <BottomSheet
      accessibilityRole="alert"
      className="max-h-[88%]"
      onClose={onClose}
      visible={Boolean(row)}
    >
      <View className="gap-4">
        <View className="gap-1">
          <Text className="text-lg font-bold text-foreground">Not changed</Text>
          <Text className="text-sm text-muted-foreground">{row?.label}</Text>
        </View>
        <TextInput
          accessibilityLabel="Why this filter was not changed"
          autoFocus
          className="min-h-11 rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground"
          multiline
          onChangeText={setReason}
          placeholder="Why it was not changed"
          placeholderTextColor={theme.mutedForeground}
          value={reason}
        />
        <View className="flex-row gap-3">
          <Button
            className="flex-1"
            label="Cancel"
            onPress={() => {
              setReason('');
              onClose();
            }}
            variant="secondary"
          />
          <Button
            className="flex-1"
            disabled={!reason.trim()}
            label="Save"
            onPress={() => {
              onSave(reason.trim());
              setReason('');
            }}
          />
        </View>
      </View>
    </BottomSheet>
  );
}

/** A register the technician found that the visit never listed. */
function AddFilterSheet({
  visible,
  onClose,
  onAdd,
}: {
  visible: boolean;
  onClose: () => void;
  onAdd: (size: string, location: string) => void;
}) {
  const theme = useThemeColors();
  const [size, setSize] = useState('');
  const [location, setLocation] = useState('');
  const valid = FILTER_SIZE_PATTERN.test(size);

  const close = () => {
    setSize('');
    setLocation('');
    onClose();
  };

  return (
    <BottomSheet className="max-h-[88%]" onClose={close} visible={visible}>
      <View className="gap-4">
        <View className="gap-1">
          <Text className="text-lg font-bold text-foreground">A filter you found</Text>
          <Text className="text-sm text-muted-foreground">
            One the visit did not list. The office reads it as a correction to their record.
          </Text>
        </View>
        <TextInput
          accessibilityLabel="Filter size"
          autoCapitalize="none"
          className="min-h-11 rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground"
          keyboardType="numbers-and-punctuation"
          onChangeText={setSize}
          placeholder="Size, like 20x25x1"
          placeholderTextColor={theme.mutedForeground}
          value={size}
        />
        {size.length > 0 && !valid ? (
          <Text className="text-xs text-destructive">Write it like 20x25x1.</Text>
        ) : null}
        <TextInput
          accessibilityLabel="Where the filter is"
          className="min-h-11 rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground"
          onChangeText={setLocation}
          placeholder="Where it is (optional)"
          placeholderTextColor={theme.mutedForeground}
          value={location}
        />
        <View className="flex-row gap-3">
          <Button className="flex-1" label="Cancel" onPress={close} variant="secondary" />
          <Button
            className="flex-1"
            disabled={!valid}
            label="Add"
            onPress={() => {
              onAdd(normalizeFilterSize(size), location.trim());
              setSize('');
              setLocation('');
            }}
          />
        </View>
      </View>
    </BottomSheet>
  );
}

export default function JobFiltersScreen() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const inspection = useInspection(id);
  const actions = useInspectionActions(id);
  const [notChanged, setNotChanged] = useState<FilterRow | null>(null);
  const [adding, setAdding] = useState(false);
  const [wholeService, setWholeService] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (inspection.isLoading || !inspection.data) {
    return (
      <SafeAreaView edges={['top']} className="flex-1 bg-background">
        <DetailSkeleton sections={3} />
      </SafeAreaView>
    );
  }

  const item = inspection.data;
  const report = item.servicesReport ?? null;
  const rows = filterRows(item.visitDetails, report);
  const changedTotal = rows.filter((row) => row.answer?.changed).length;

  const save = (next: Parameters<typeof actions.saveServices.mutate>[0]) => {
    setError(null);
    actions.saveServices.mutate(next, {
      // A held answer is kept on the device, which the mutation has already
      // written into the cached job. Anything else is worth saying out loud.
      onError: (caught) =>
        setError(caught instanceof Error && caught.name === 'QueuedOfflineError' ? null : 'Could not save that. It will retry.'),
    });
  };

  /**
   * Opens the camera for one register.
   *
   * The area the photographs are filed under is made on the first one, so it is
   * resolved here rather than when the job is opened: a job whose filters
   * nobody photographs never grows an area at all.
   */
  const photograph = async (row: FilterRow) => {
    setOpening(row.label);
    setError(null);
    try {
      const areaId = await actions.filtersArea.mutateAsync();
      router.push({
        pathname: '/camera/[inspectionId]/[areaId]',
        params: {
          inspectionId: id,
          areaId,
          filterSize: row.filter.size,
          filterLocation: row.filter.location ?? '',
          filterSlot: String(row.filter.slot),
          filterBooked: row.answer?.booked === false ? 'false' : 'true',
          filterLabel: row.label,
        },
      });
    } catch {
      setError('Could not open the camera for that filter. Try again in a moment.');
    } finally {
      setOpening(null);
    }
  };

  return (
    <SafeAreaView edges={['top']} className="flex-1 bg-background">
      <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 48 }}>
        <View className="flex-row items-center gap-3 px-5 pb-3 pt-2">
          <Button
            accessibilityLabel="Back"
            className="h-9 w-9 px-0 py-0"
            icon={<BackGlyph size={18} className="text-foreground" />}
            label=""
            onPress={() => goBack()}
            variant="secondary"
          />
          <View className="min-w-0 flex-1">
            <Text numberOfLines={1} className="text-lg font-bold text-foreground">
              AC filter change
            </Text>
            <Text numberOfLines={1} className="text-xs text-muted-foreground">
              {item.property.address}
            </Text>
          </View>
          <HomeButton />
        </View>

        <Card className="mx-5 gap-2">
          <Text className="text-sm text-foreground">
            Photograph each filter after you fit it, with the size printed on the filter in shot.
          </Text>
          <Text className="text-xs text-muted-foreground">
            {rows.length
              ? `${changedTotal} of ${rows.length} done`
              : 'The visit listed no sizes. Add what you find.'}
          </Text>
        </Card>

        {error ? (
          <Text className="mx-5 mt-3 text-xs text-destructive" accessibilityRole="alert">
            {error}
          </Text>
        ) : null}

        <View className="mt-4 gap-2 px-5">
          {rows.map((row) => {
            const answer = row.answer;
            const photographed = Boolean(answer?.changed && (answer.photoId || answer.photoKey));
            const refused = Boolean(answer && !answer.changed);
            return (
              <Card className="gap-3" key={`${row.filter.size}-${row.filter.location}-${row.filter.slot}`}>
                <View className="flex-row items-start gap-3">
                  {photographed ? (
                    <CheckCircle2Icon size={20} className="text-chart-3" />
                  ) : refused ? (
                    <XCircleIcon size={20} className="text-chart-4" />
                  ) : (
                    <CircleIcon size={18} className="text-muted-foreground" />
                  )}
                  <View className="min-w-0 flex-1">
                    <Text className="text-sm font-semibold text-foreground">{row.label}</Text>
                    <Text className="mt-0.5 text-xs text-muted-foreground">
                      {photographed
                        ? answer?.photoId
                          ? 'Photographed'
                          : 'Photographed · sending'
                        : refused
                          ? `Not changed — ${answer?.reason ?? ''}`
                          : row.filter.media
                            ? 'Media filter'
                            : 'Not done yet'}
                    </Text>
                  </View>
                  {row.answer?.booked === false ? (
                    <Button
                      accessibilityLabel={`Remove ${row.label}`}
                      className="h-9 w-9 px-0 py-0"
                      icon={<Trash2Icon size={16} className="text-muted-foreground" />}
                      label=""
                      onPress={() => save(withoutFilter(report, row.filter))}
                      variant="quiet"
                    />
                  ) : null}
                </View>
                <View className="flex-row gap-3">
                  <Button
                    busy={opening === row.label}
                    className="flex-1"
                    icon={<CameraIcon size={16} className="text-primary-foreground" />}
                    label={photographed ? 'Retake' : 'Photograph'}
                    onPress={() => void photograph(row)}
                  />
                  <Button
                    className="flex-1"
                    label={refused ? 'Change the reason' : 'Not changed'}
                    onPress={() => setNotChanged(row)}
                    variant="secondary"
                  />
                </View>
              </Card>
            );
          })}
        </View>

        <View className="mt-4 gap-3 px-5">
          <Button
            icon={<PlusIcon size={16} className="text-foreground" />}
            label="A filter you found"
            onPress={() => setAdding(true)}
            variant="secondary"
          />
          {/* The service, rather than a register: nobody was let near the
              filters at all, which the office reads as one answer. */}
          <Button
            label="The filter change did not happen"
            onPress={() => setWholeService(true)}
            variant="quiet"
          />
          {actions.saveServices.isPending ? (
            <View className="flex-row items-center gap-2">
              <Loader size="sm" />
              <Text className="text-xs text-muted-foreground">Saving…</Text>
            </View>
          ) : null}
        </View>
      </ScrollView>

      <NotChangedSheet
        onClose={() => setNotChanged(null)}
        onSave={(reason) => {
          if (notChanged)
            save(withFilterAnswer(report, notChanged.filter, { changed: false, reason }));
          setNotChanged(null);
        }}
        row={notChanged}
      />

      <AddFilterSheet
        onAdd={(size, location) => {
          setAdding(false);
          // Added as not changed and unanswered, so the next tap is the
          // photograph rather than a claim nobody has evidenced.
          save(
            withFilterAnswer(
              report,
              { size, location: location || null, slot: 1 },
              { changed: false, reason: 'Found on site' },
              { booked: false },
            ),
          );
        }}
        onClose={() => setAdding(false)}
        visible={adding}
      />

      <ServiceAnswerSheet
        answer={
          report?.services.filterChange
            ? {
                done: report.services.filterChange.done,
                reason: report.services.filterChange.reason,
                reschedule: report.services.filterChange.reschedule,
              }
            : undefined
        }
        onAnswer={(next) => {
          setWholeService(false);
          save(withServiceAnswer(report, 'filterChange', next));
          if (!next.done) goBack();
        }}
        onClose={() => setWholeService(false)}
        title="AC filter change"
        visible={wholeService}
      />
    </SafeAreaView>
  );
}
