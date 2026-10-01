import { router, useLocalSearchParams } from 'expo-router';
import {
  CameraIcon,
  CheckCircle2Icon,
  CircleIcon,
  ImageIcon,
  MinusIcon,
  PlusIcon,
  Trash2Icon,
  XCircleIcon,
} from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  filterAssessed,
  FILTER_SIZE_PATTERN,
  MAX_BOOKED_FILTERS,
  normalizeFilterSize,
  type VisitServicesReport,
} from '@texasrenters/shared';

import { AxisRow } from '@/src/capture/AreaChecklistSheet';

import { BottomSheet } from '@/src/components/BottomSheet';
import { HomeButton } from '@/src/components/HomeButton';
import { ServiceAnswerSheet } from '@/src/components/ServiceAnswerSheet';
import { Button, Card, Loader } from '@/src/components/ui';
import { BackGlyph } from '@/src/components/ui/BackGlyph';
import { DetailSkeleton } from '@/src/components/ui/Skeleton';
import { useFiltersArea, useInspection, useInspectionActions } from '@/src/features/queries';
import { importFromGallery } from '@/src/media/gallery-import';
import { registerIcons } from '@/src/lib/icons';
import { goBack } from '@/src/lib/navigation';
import { useDemoStore } from '@/src/stores/demo.store';
import { useThemeColors } from '@/src/lib/theme-colors';
import {
  filterDeclined,
  filterRowSettled,
  filterRows,
  filterRulesFor,
  filtersPhoto,
  withAddedFilters,
  withFilterAnswer,
  withFilterAssessment,
  withFilterInPhoto,
  withFilterRemoved,
  withFilterSize,
  withFilterUndeclined,
  withFiltersPhoto,
  withServiceAnswer,
  withoutFilter,
  type FilterEntry,
  type FilterRow,
  type FilterRules,
} from '@/src/utils/job-tasks';

registerIcons(CameraIcon, CheckCircle2Icon, CircleIcon, ImageIcon, MinusIcon, PlusIcon, Trash2Icon, XCircleIcon);

/**
 * The job's filters, and one photograph of them all.
 *
 * The office, 2026-09-29: the technician stacks the filters with the sizes
 * facing the camera and takes one picture -- "not add a filter for this size
 * then add another filter for this size then take a photo one by one". It
 * replaces a photograph per register (2026-09-18), which cost a trip through
 * the camera for every filter in the house.
 *
 * The registers still come from what the coordinator listed on the visit,
 * expanded by quantity, and each can still be declined with a reason, because
 * the office acts on a filter nobody could change. Filters found on site are
 * added in one go, every size at once.
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

const blankEntry = (): FilterEntry => ({ size: '', quantity: 1 });

/**
 * Every filter found on site, listed at once: a size and how many of it per
 * line, and another line for the next size.
 */
function AddFiltersSheet({
  visible,
  onClose,
  onAdd,
}: {
  visible: boolean;
  onClose: () => void;
  onAdd: (entries: FilterEntry[]) => void;
}) {
  const theme = useThemeColors();
  const [entries, setEntries] = useState<FilterEntry[]>(() => [blankEntry()]);
  const filled = entries.filter((entry) => entry.size.trim());
  const invalid = filled.some((entry) => !FILTER_SIZE_PATTERN.test(entry.size));
  const total = filled.reduce((sum, entry) => sum + entry.quantity, 0);

  const update = (index: number, patch: Partial<FilterEntry>) =>
    setEntries((current) => current.map((entry, at) => (at === index ? { ...entry, ...patch } : entry)));
  const close = () => {
    setEntries([blankEntry()]);
    onClose();
  };

  return (
    <BottomSheet className="max-h-[88%]" onClose={close} visible={visible}>
      <View className="gap-4">
        <View className="gap-1">
          <Text className="text-lg font-bold text-foreground">Add filters</Text>
          <Text className="text-sm text-muted-foreground">
            Every size you found, with how many of each.
          </Text>
        </View>
        <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 280 }}>
          <View className="gap-2">
            {entries.map((entry, index) => (
              <View className="flex-row items-center gap-2" key={index}>
                <TextInput
                  accessibilityLabel={`Filter size ${index + 1}`}
                  autoCapitalize="none"
                  autoFocus={index > 0 && index === entries.length - 1}
                  className="min-h-11 flex-1 rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground"
                  keyboardType="numbers-and-punctuation"
                  onChangeText={(size) => update(index, { size })}
                  placeholder="Size, like 20x25x1"
                  placeholderTextColor={theme.mutedForeground}
                  value={entry.size}
                />
                <Pressable
                  accessibilityLabel={`One fewer of filter ${index + 1}`}
                  accessibilityRole="button"
                  className="h-11 w-11 items-center justify-center rounded-xl border border-border bg-card active:opacity-70"
                  disabled={entry.quantity <= 1}
                  onPress={() => update(index, { quantity: Math.max(1, entry.quantity - 1) })}
                >
                  <MinusIcon
                    size={16}
                    className={entry.quantity <= 1 ? 'text-muted-foreground' : 'text-foreground'}
                  />
                </Pressable>
                <Text
                  accessibilityLabel={`${entry.quantity} of this size`}
                  className="w-6 text-center text-base font-bold text-foreground"
                >
                  {entry.quantity}
                </Text>
                <Pressable
                  accessibilityLabel={`One more of filter ${index + 1}`}
                  accessibilityRole="button"
                  className="h-11 w-11 items-center justify-center rounded-xl border border-border bg-card active:opacity-70"
                  disabled={entry.quantity >= MAX_BOOKED_FILTERS}
                  onPress={() =>
                    update(index, { quantity: Math.min(MAX_BOOKED_FILTERS, entry.quantity + 1) })
                  }
                >
                  <PlusIcon size={16} className="text-foreground" />
                </Pressable>
                {entries.length > 1 ? (
                  <Pressable
                    accessibilityLabel={`Remove filter ${index + 1}`}
                    accessibilityRole="button"
                    className="h-11 w-9 items-center justify-center active:opacity-70"
                    onPress={() => setEntries((current) => current.filter((_, at) => at !== index))}
                  >
                    <Trash2Icon size={16} className="text-muted-foreground" />
                  </Pressable>
                ) : null}
              </View>
            ))}
          </View>
        </ScrollView>
        {invalid ? <Text className="text-xs text-destructive">Write each size like 20x25x1.</Text> : null}
        <Button
          icon={<PlusIcon size={16} className="text-foreground" />}
          label="Another size"
          onPress={() => setEntries((current) => [...current, blankEntry()])}
          variant="secondary"
        />
        <View className="flex-row gap-3">
          <Button className="flex-1" label="Cancel" onPress={close} variant="secondary" />
          <Button
            className="flex-1"
            disabled={!total || invalid}
            label={total ? `Add ${total} filter${total === 1 ? '' : 's'}` : 'Add'}
            onPress={() => {
              onAdd(filled);
              setEntries([blankEntry()]);
            }}
          />
        </View>
      </View>
    </BottomSheet>
  );
}

/** In the photograph: answered as changed, with the photograph's key or id. */
const inPhoto = (row: FilterRow) => Boolean(row.answer?.changed && (row.answer.photoKey || row.answer.photoId));

/** The size a filter really is, when the one listed is wrong (Moses, 2026-10-01). */
function ResizeSheet({
  row,
  onClose,
  onSave,
}: {
  row: FilterRow | null;
  onClose: () => void;
  onSave: (size: string) => void;
}) {
  const theme = useThemeColors();
  const [size, setSize] = useState('');
  const valid = FILTER_SIZE_PATTERN.test(size);
  const close = () => {
    setSize('');
    onClose();
  };
  return (
    <BottomSheet className="max-h-[88%]" onClose={close} visible={Boolean(row)}>
      <View className="gap-4">
        <View className="gap-1">
          <Text className="text-lg font-bold text-foreground">Change the size</Text>
          <Text className="text-sm text-muted-foreground">
            {row ? `Listed as ${row.filter.size}. The office sees both.` : ''}
          </Text>
        </View>
        <TextInput
          accessibilityLabel="The filter's real size"
          autoCapitalize="none"
          autoFocus
          className="min-h-11 rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground"
          keyboardType="numbers-and-punctuation"
          onChangeText={setSize}
          placeholder="Size, like 20x25x1"
          placeholderTextColor={theme.mutedForeground}
          value={size}
        />
        {size.length && !valid ? <Text className="text-xs text-destructive">Write it like 20x25x1.</Text> : null}
        <View className="flex-row gap-3">
          <Button className="flex-1" label="Cancel" onPress={close} variant="secondary" />
          <Button
            className="flex-1"
            disabled={!valid}
            label="Save"
            onPress={() => {
              onSave(normalizeFilterSize(size));
              setSize('');
            }}
          />
        </View>
      </View>
    </BottomSheet>
  );
}

/**
 * One filter on an HVAC job: scored where it is photographed (Moses,
 * 2026-10-01: "Keep the AC filter change and remove it from the HVAC
 * inspection part of it. Include the questions on the AC filter change part of
 * it.").
 *
 * Clean, Undamaged and Working, or a comment where it could not be scored --
 * the rule the HVAC inspection's Filters section had. The row is a filter the
 * house really has, so there is no "Not present": a filter the visit listed
 * that is not there is removed, and one listed at the wrong size is corrected
 * ("make it where I can adjust the amount of filters, remove or change as
 * necessary"). Every tap saves only what it changed (`withFilterAssessment`).
 */
function HvacFilterRow({
  row,
  last,
  rules,
  photo,
  onSave,
  onNotChanged,
  onResize,
}: {
  row: FilterRow;
  last: boolean;
  rules: FilterRules;
  /** The photograph the filters share, once taken. */
  photo: { photoKey: string | null; photoId: string | null } | null;
  onSave: (update: (current: VisitServicesReport | null) => VisitServicesReport) => void;
  onNotChanged: (row: FilterRow) => void;
  onResize: (row: FilterRow) => void;
}) {
  const theme = useThemeColors();
  const answer = row.answer;
  const listed = answer?.booked !== false;
  const removed = Boolean(answer?.removed);
  const declined = filterDeclined(answer);
  const scored = Boolean(answer && filterAssessed(answer));
  const settled = filterRowSettled(row, rules);
  const options = { booked: listed };

  const status = removed
    ? 'Not at the property'
    : [
        scored ? 'Scored' : 'To score',
        declined
          ? `not changed — ${answer?.reason ?? ''}`
          : inPhoto(row)
            ? 'in the photo'
            : rules.changeAsked
              ? photo
                ? 'not in the photo yet'
                : 'to photograph'
              : null,
      ]
        .filter(Boolean)
        .join(' · ');

  return (
    <View className={`gap-2 py-3 ${last ? '' : 'border-b border-border'}`}>
      <View className="flex-row items-center gap-3">
        {settled && !removed ? (
          <CheckCircle2Icon size={20} className="text-chart-3" />
        ) : removed ? (
          <XCircleIcon size={20} className="text-muted-foreground" />
        ) : (
          <CircleIcon size={18} className="text-muted-foreground" />
        )}
        <View className="min-w-0 flex-1">
          <Text className={`text-sm font-semibold ${removed ? 'text-muted-foreground line-through' : 'text-foreground'}`}>
            {row.label}
          </Text>
          {answer?.actualSize && !removed ? (
            <Text className="text-xs text-muted-foreground">Listed as {row.filter.size}</Text>
          ) : null}
          <Text numberOfLines={2} className="mt-0.5 text-xs text-muted-foreground">
            {status}
          </Text>
        </View>
      </View>

      {removed ? null : (
        <>
          <AxisRow
            assessment={answer}
            label={row.label}
            onAnswer={(axis, next) =>
              onSave((current) => withFilterAssessment(current, row.filter, { [axis]: next }, options))
            }
          />
          <TextInput
            accessibilityLabel={`Comment on ${row.label}, or why it could not be scored`}
            className="min-h-11 rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground"
            defaultValue={answer?.comment ?? ''}
            // Keyed by the saved comment: the field is uncontrolled, so a
            // comment saved elsewhere has to remount it to show.
            key={`${row.filter.size}-${row.filter.slot}:${answer?.comment ?? ''}`}
            onEndEditing={(event) => {
              const comment = event.nativeEvent.text.trim() || null;
              if (comment !== (answer?.comment ?? null))
                onSave((current) => withFilterAssessment(current, row.filter, { comment }, options));
            }}
            placeholder="Comment, or why it could not be scored"
            placeholderTextColor={theme.mutedForeground}
          />
        </>
      )}

      <View className="flex-row flex-wrap gap-x-4">
        {removed ? (
          <Pressable
            accessibilityLabel={`Put ${row.label} back`}
            accessibilityRole="button"
            className="min-h-11 justify-center active:opacity-70"
            onPress={() => onSave((current) => withFilterRemoved(current, row.filter, false))}
          >
            <Text className="text-xs font-semibold text-primary">Undo</Text>
          </Pressable>
        ) : (
          <>
            <Pressable
              accessibilityLabel={`Change the size of ${row.label}`}
              accessibilityRole="button"
              className="min-h-11 justify-center active:opacity-70"
              onPress={() => onResize(row)}
            >
              <Text className="text-xs font-semibold text-primary">Change size</Text>
            </Pressable>
            {rules.changeAsked ? (
              declined ? (
                <Pressable
                  accessibilityLabel={`Undo not changed for ${row.label}`}
                  accessibilityRole="button"
                  className="min-h-11 justify-center active:opacity-70"
                  onPress={() => onSave((current) => withFilterUndeclined(current, row.filter, photo))}
                >
                  <Text className="text-xs font-semibold text-primary">Undo not changed</Text>
                </Pressable>
              ) : (
                <Pressable
                  accessibilityLabel={`${row.label} was not changed`}
                  accessibilityRole="button"
                  className="min-h-11 justify-center active:opacity-70"
                  onPress={() => onNotChanged(row)}
                >
                  <Text className="text-xs font-semibold text-muted-foreground">Not changed</Text>
                </Pressable>
              )
            ) : null}
            <Pressable
              accessibilityLabel={listed ? `${row.label} is not at the property` : `Remove ${row.label}`}
              accessibilityRole="button"
              className="min-h-11 flex-row items-center gap-1 active:opacity-70"
              onPress={() =>
                onSave((current) =>
                  listed ? withFilterRemoved(current, row.filter, true) : withoutFilter(current, row.filter),
                )
              }
            >
              <Trash2Icon size={14} className="text-muted-foreground" />
              <Text className="text-xs font-semibold text-muted-foreground">
                {listed ? 'Not here' : 'Remove'}
              </Text>
            </Pressable>
          </>
        )}
      </View>
    </View>
  );
}

export default function JobFiltersScreen() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const inspection = useInspection(id);
  const actions = useInspectionActions(id);
  // Asked for as the screen opens, so the camera never waits on it.
  const filtersArea = useFiltersArea(id, inspection.data?.status === 'IN_PROGRESS');
  const [notChanged, setNotChanged] = useState<FilterRow | null>(null);
  const [resizing, setResizing] = useState<FilterRow | null>(null);
  const [adding, setAdding] = useState(false);
  const [wholeService, setWholeService] = useState(false);
  const [opening, setOpening] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const addSnapshot = useDemoStore((state) => state.addSnapshot);
  const ownerUserId = useDemoStore((state) => state.selectedUserId ?? undefined);

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
  /** On an HVAC job each filter is scored too, and listed ones can be corrected (Moses, 2026-10-01). */
  const rules = filterRulesFor(item.visitDetails, item.type);
  const photo = filtersPhoto(rows);
  /** The filters the photograph is of: every one nobody declined, and that is there. */
  const toPhotograph = rows.filter((row) => !filterDeclined(row.answer) && !row.answer?.removed);
  const declinedTotal = rows.length - toPhotograph.length;
  /** Added after the photograph was taken, so not in it. */
  const missing = toPhotograph.filter((row) => !inPhoto(row));
  /**
   * Taken, but the server has not confirmed it yet: `photoKey` is written the
   * moment the shutter fires and `photoId` arrives when the upload lands.
   */
  const sending = toPhotograph.some((row) => inPhoto(row) && !row.answer?.photoId);

  const save = (next: Parameters<typeof actions.saveServices.mutate>[0]) => {
    setError(null);
    actions.saveServices.mutate(next, {
      // A held answer is kept on the device, which the mutation has already
      // written into the cached job. Anything else is worth saying out loud --
      // and it is not retried: what reaches here is the server refusing the
      // answer or failing on it, neither of which the queue will send again.
      onError: (caught) =>
        setError(
          caught instanceof Error && caught.name === 'QueuedOfflineError'
            ? null
            : 'That did not save. Try again.',
        ),
    });
  };

  /**
   * One photograph of every filter not declined.
   *
   * The area it is filed under was asked for when the screen opened, so this
   * is normally straight into the camera; it waits only when that request has
   * not come back, or failed and has to be asked again.
   */
  /** The area the photograph is filed under, asked for again only if the screen's request has not answered. */
  const resolveArea = async () => {
    if (filtersArea.data) return filtersArea.data;
    setOpening(true);
    try {
      return (await filtersArea.refetch()).data;
    } finally {
      setOpening(false);
    }
  };

  const photograph = async () => {
    if (!toPhotograph.length) return;
    setError(null);
    const areaId = await resolveArea();
    if (!areaId) {
      setError('Could not open the camera. Check the connection and try again.');
      return;
    }
    router.push({
      pathname: '/camera/[inspectionId]/[areaId]',
      params: {
        inspectionId: id,
        areaId,
        filterAll: '1',
        filterLabel: `${toPhotograph.length} filter${toPhotograph.length === 1 ? '' : 's'}`,
      },
    });
  };

  /**
   * The same one photograph, picked from the phone's gallery (the office,
   * 2026-09-29): a technician who has already photographed the stacked filters
   * with the phone's own camera hands that picture over instead.
   *
   * One picture, filed exactly as the camera files it -- the upload queue sends
   * it, with no signal too -- and attached to every filter not declined, like a
   * shot from the camera. Offered on every kind of job: the filter change is
   * not the inspection, so the rule that keeps gallery photographs off move-ins
   * and move-outs (`inspectionAllowsGalleryImport`) is about something else.
   */
  const pickFromGallery = async () => {
    if (!toPhotograph.length || picking) return;
    setError(null);
    const areaId = await resolveArea();
    if (!areaId) {
      setError('Could not open your photos. Check the connection and try again.');
      return;
    }
    setPicking(true);
    try {
      const outcome = await importFromGallery({
        inspectionId: id,
        roomId: areaId,
        ownerUserId,
        existingPhotoCount: 0,
        single: true,
        // Of labels -- the sizes printed on the filters -- as the camera's is.
        captureType: 'SERIAL_OR_LABEL',
      });
      if (outcome.status === 'DENIED') {
        setError('TexasRenters Inspect cannot see your photos. Allow photo access in Settings, then try again.');
        return;
      }
      const [snapshot] = outcome.status === 'IMPORTED' ? outcome.snapshots : [];
      if (!snapshot) return;
      addSnapshot(snapshot);
      save((current) => withFiltersPhoto(current, item.visitDetails, snapshot.id));
    } catch {
      setError('That photo could not be added. Try again.');
    } finally {
      setPicking(false);
    }
  };

  const photoLabel =
    (!toPhotograph.length
      ? rows.length
        ? 'Every filter is marked not changed'
        : 'Add the filters first'
      : photo && !missing.length
        ? 'Retake the photo'
        : toPhotograph.length === 1
          ? 'Photograph the filter'
          : `Photograph all ${toPhotograph.length} filters`) +
    // An HVAC visit that booked no change asks for the scores alone.
    (rules.changeAsked || !toPhotograph.length ? '' : ' (optional)');

  return (
    <SafeAreaView edges={['top']} className="flex-1 bg-background">
      <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 240 }}>
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
            {rules.assess
              ? rules.changeAsked
                ? 'Score every filter Clean, Undamaged and Working. Then stack them with the sizes facing the camera and take one photo of them all.'
                : 'Score every filter Clean, Undamaged and Working. A photo of them stacked is optional.'
              : 'Stack every filter with its size facing the camera, and take one photo of them all.'}
          </Text>
          <Text className="text-xs text-muted-foreground">
            {rows.length
              ? `${rows.length} filter${rows.length === 1 ? '' : 's'}${
                  declinedTotal ? ` · ${declinedTotal} not changed` : ''
                }`
              : 'The visit listed no sizes. Add the filters you find.'}
          </Text>
        </Card>

        {error ? (
          <Text className="mx-5 mt-3 text-xs text-destructive" accessibilityRole="alert">
            {error}
          </Text>
        ) : null}

        {rows.length && rules.assess ? (
          <Card className="mx-5 mt-4 gap-0 py-1">
            {rows.map((row, index) => (
              <HvacFilterRow
                key={`${row.filter.size}-${row.filter.location}-${row.filter.slot}`}
                last={index === rows.length - 1}
                onNotChanged={setNotChanged}
                onResize={setResizing}
                onSave={save}
                photo={photo}
                row={row}
                rules={rules}
              />
            ))}
          </Card>
        ) : rows.length ? (
          <Card className="mx-5 mt-4 gap-0 py-1">
            {rows.map((row, index) => {
              const answer = row.answer;
              const declined = filterDeclined(answer);
              const shot = inPhoto(row);
              return (
                <View
                  className={`flex-row items-center gap-3 py-2.5 ${
                    index < rows.length - 1 ? 'border-b border-border' : ''
                  }`}
                  key={`${row.filter.size}-${row.filter.location}-${row.filter.slot}`}
                >
                  {declined ? (
                    <XCircleIcon size={20} className="text-chart-4" />
                  ) : shot ? (
                    <CheckCircle2Icon size={20} className="text-chart-3" />
                  ) : (
                    <CircleIcon size={18} className="text-muted-foreground" />
                  )}
                  <View className="min-w-0 flex-1">
                    <Text className="text-sm font-semibold text-foreground">{row.label}</Text>
                    <Text numberOfLines={2} className="mt-0.5 text-xs text-muted-foreground">
                      {declined
                        ? `Not changed — ${answer?.reason ?? ''}`
                        : shot
                          ? 'In the photo'
                          : photo
                            ? 'Not in the photo yet'
                            : row.filter.media
                              ? 'Media filter'
                              : 'To photograph'}
                    </Text>
                  </View>
                  {declined ? (
                    <Pressable
                      accessibilityLabel={`Undo not changed for ${row.label}`}
                      accessibilityRole="button"
                      className="min-h-11 justify-center px-2 active:opacity-70"
                      onPress={() => save((current) => withFilterInPhoto(current, row.filter, photo))}
                    >
                      <Text className="text-xs font-semibold text-primary">Undo</Text>
                    </Pressable>
                  ) : (
                    <Pressable
                      accessibilityLabel={`${row.label} was not changed`}
                      accessibilityRole="button"
                      className="min-h-11 justify-center px-2 active:opacity-70"
                      onPress={() => setNotChanged(row)}
                    >
                      <Text className="text-xs font-semibold text-muted-foreground">Not changed</Text>
                    </Pressable>
                  )}
                  {answer?.booked === false ? (
                    <Pressable
                      accessibilityLabel={`Remove ${row.label}`}
                      accessibilityRole="button"
                      className="h-11 w-9 items-center justify-center active:opacity-70"
                      onPress={() => save((current) => withoutFilter(current, row.filter))}
                    >
                      <Trash2Icon size={16} className="text-muted-foreground" />
                    </Pressable>
                  ) : null}
                </View>
              );
            })}
          </Card>
        ) : null}

        <View className="mt-4 gap-3 px-5">
          <Button
            icon={<PlusIcon size={16} className="text-foreground" />}
            label="Add filters"
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

      {/* The one photograph, under the list it is of. */}
      <View className="absolute bottom-0 left-0 right-0 gap-2 border-t border-border bg-background px-5 pb-8 pt-3">
        {photo ? (
          <View className="flex-row items-center gap-2">
            {sending ? (
              <Loader accessibilityLabel="Sending the photo" size="sm" />
            ) : (
              <CheckCircle2Icon size={16} className="text-chart-3" />
            )}
            <Text className="flex-1 text-xs text-muted-foreground">
              {missing.length
                ? `${missing.length} filter${missing.length === 1 ? '' : 's'} not in the photo — take it again with all of them`
                : sending
                  ? 'Photo taken · sending…'
                  : 'Photo sent'}
            </Text>
          </View>
        ) : null}
        <Button
          busy={opening}
          busyLabel="Opening the camera…"
          disabled={!toPhotograph.length}
          icon={<CameraIcon size={18} className="text-primary-foreground" />}
          label={photoLabel}
          onPress={() => void photograph()}
          variant={photo && !missing.length ? 'secondary' : rules.changeAsked ? 'primary' : 'secondary'}
        />
        {toPhotograph.length ? (
          <Button
            busy={picking}
            busyLabel="Opening your photos…"
            icon={<ImageIcon size={18} className="text-foreground" />}
            label="Choose from gallery"
            onPress={() => void pickFromGallery()}
            variant="secondary"
          />
        ) : null}
      </View>

      <NotChangedSheet
        onClose={() => setNotChanged(null)}
        onSave={(reason) => {
          if (notChanged)
            save((current) => withFilterAnswer(current, notChanged.filter, { changed: false, reason }));
          setNotChanged(null);
        }}
        row={notChanged}
      />

      <ResizeSheet
        onClose={() => setResizing(null)}
        onSave={(size) => {
          const row = resizing;
          setResizing(null);
          if (row)
            save((current) => withFilterSize(current, row.filter, size, { booked: row.answer?.booked !== false }));
        }}
        row={resizing}
      />

      <AddFiltersSheet
        onAdd={(entries) => {
          setAdding(false);
          // Added unanswered, so they read "not in the photo" until one is
          // taken with them in it, rather than as a claim nobody has evidenced.
          save((current) => withAddedFilters(current, item.visitDetails, entries));
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
          save((current) => withServiceAnswer(current, 'filterChange', next));
          if (!next.done) goBack();
        }}
        onClose={() => setWholeService(false)}
        title="AC filter change"
        visible={wholeService}
      />
    </SafeAreaView>
  );
}
