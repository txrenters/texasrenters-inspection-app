import { useCallback, useEffect, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import {
  AlertTriangleIcon,
  CameraIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleIcon,
  FileTextIcon,
  PlusIcon,
  Settings2Icon,
} from 'lucide-react-native';
import { Alert, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { applyAreaOrder, loadAreaOrder, saveAreaOrder } from '@/src/areas/area-order';
import { ReorderableAreaList } from '@/src/areas/ReorderableAreaList';
import { AddAreaSheet } from '@/src/components/AddAreaSheet';
import { HomeButton } from '@/src/components/HomeButton';
import { PriorityAuditList } from '@/src/components/PriorityAuditList';
import { BackGlyph } from '@/src/components/ui/BackGlyph';
import { DetailSkeleton } from '@/src/components/ui/Skeleton';
import type { Finding, InspectionRoom } from '@/src/domain/models';
import { useFindings, useInspection, useRooms, useSkipAreas } from '@/src/features/queries';
import { usePullToRefresh } from '@/src/features/usePullToRefresh';
import { registerIcons } from '@/src/lib/icons';
import { goBack } from '@/src/lib/navigation';
import { useThemeColors } from '@/src/lib/theme-colors';
import { deriveAreaStatus, pickUpNextArea, type AreaStatusDescriptor } from '@/src/utils/area-status';
import { buildPriorityChecklist, summaryCoverage } from '@/src/utils/inspection-audit';
import { bulkSkippableAreas } from '@/src/utils/submission-gate';

registerIcons(
  AlertTriangleIcon,
  CameraIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleIcon,
  FileTextIcon,
  PlusIcon,
  Settings2Icon,
);

/**
 * The inspection of a job: its areas, opened from the job's list.
 *
 * The office (2026-09-18) wanted the job screen to be the job's list and
 * nothing else -- "Pest control just a check box, filter change can be
 * clicked, then inspection can be clicked also" -- so the inspection's own
 * work lives here: the areas to walk, what the AI has flagged, and the
 * findings. End job is on the job's list, not here; this screen hands back to
 * it once the last area is done.
 */

/** What each kind of inspection is called here. */
const INSPECTION_TITLE: Record<string, string> = {
  MOVE_IN: 'Move-in inspection',
  MOVE_OUT: 'Move-out inspection',
  OCCUPIED: 'Occupied inspection',
  BACK_TO_MARKET: 'Back-to-market inspection',
  HVAC: 'HVAC inspection',
  ROOF: 'Roof inspection',
};

const TONE_TEXT: Record<AreaStatusDescriptor['tone'], string> = {
  neutral: 'text-muted-foreground',
  info: 'text-chart-2',
  progress: 'text-chart-2',
  success: 'text-chart-3',
  warning: 'text-chart-4',
  danger: 'text-destructive',
};

function isRoomDone(room: InspectionRoom) {
  const { status } = deriveAreaStatus(room);
  return status === 'COMPLETED' || status === 'SKIPPED';
}

function RoomRow({
  room,
  findings,
  dragging = false,
}: {
  room: InspectionRoom;
  findings: Finding[];
  /** Held by the technician right now: a lifted row reads as picked up, not merely selected. */
  dragging?: boolean;
}) {
  // Derived rather than open-coded: a failed upload surfaces on this row rather
  // than reading as "not started", which is the one state a technician has to
  // act on before leaving the property.
  const derived = deriveAreaStatus(room);
  const done = derived.status === 'COMPLETED' || derived.status === 'SKIPPED';
  const active = derived.status !== 'NOT_STARTED' && !done;
  const roomFindings = findings.filter((finding) => finding.roomId === room.id);
  return (
    <Pressable
      // Status is otherwise only a coloured bar and an icon, both invisible to a
      // screen reader -- it has to be said in words.
      accessibilityLabel={[
        room.name,
        room.floorName,
        room.isRequired ? 'Required' : 'Optional',
        derived.label,
        derived.detail,
        roomFindings.length ? `${roomFindings.length} findings` : '',
      ]
        .filter(Boolean)
        .join(', ')}
      accessibilityRole="button"
      accessibilityHint="Opens this area. Press and hold to move it in the list."
      className={`mx-5 mb-2 min-h-14 overflow-hidden rounded-xl bg-card ${
        // No press-scale while held: the row is already lifted by the drag.
        dragging ? 'border border-primary/40 shadow-lg' : 'active:scale-[0.98]'
      }`}
      onPress={() => router.push(`/areas/${room.id}`)}
    >
      <View importantForAccessibility="no-hide-descendants" className="flex-row items-center">
        <View
          className={`w-1.5 self-stretch ${
            derived.needsAttention ? 'bg-chart-4' : done ? 'bg-chart-3' : active ? 'bg-chart-2' : 'bg-muted'
          }`}
        />
        <View className="flex-1 flex-row items-center gap-3 p-4">
          <View
            className={`h-9 w-9 items-center justify-center rounded-full ${
              done ? 'bg-chart-3/15' : active ? 'bg-chart-2/15' : 'bg-muted'
            }`}
          >
            {done ? (
              <CheckCircle2Icon size={18} className="text-chart-3" />
            ) : active ? (
              <Settings2Icon size={18} className="text-chart-2" />
            ) : (
              <CircleIcon size={18} className="text-muted-foreground" />
            )}
          </View>
          <View className="min-w-0 flex-1">
            <Text className="text-base font-semibold text-foreground">{room.name}</Text>
            <Text className="mt-0.5 text-xs text-muted-foreground">
              {room.floorName} · {room.isRequired ? 'Required' : 'Optional'}
              {roomFindings.length ? ` · ${roomFindings.length} findings` : ''}
            </Text>
            <Text className={`mt-0.5 text-xs font-medium ${TONE_TEXT[derived.tone]}`}>{derived.label}</Text>
            {room.baseline?.summary ? (
              <Text numberOfLines={2} className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {room.baseline.summary}
              </Text>
            ) : null}
          </View>
          <ChevronRightIcon size={16} className="text-muted-foreground" />
        </View>
      </View>
    </Pressable>
  );
}

export default function JobInspectionScreen() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const inspection = useInspection(id);
  const rooms = useRooms(id);
  const findings = useFindings(id);
  const skipAreas = useSkipAreas(id);
  const theme = useThemeColors();
  const pull = usePullToRefresh([inspection.refetch, rooms.refetch, findings.refetch]);
  const [addAreaOpen, setAddAreaOpen] = useState(false);

  /**
   * The technician's own order for the areas, if they have set one.
   *
   * Up here with the other hooks, above the early return: a hook placed after
   * one runs on some renders and not others, and the screen goes down with
   * React error #310. Stored on this handset only; it changes what "Continue"
   * offers next, never the property layout the office approved.
   */
  const [areaOrder, setAreaOrder] = useState<string[]>([]);
  const [draggingArea, setDraggingArea] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void loadAreaOrder(id).then((saved) => {
      if (!cancelled) setAreaOrder(saved);
    });
    return () => {
      cancelled = true;
    };
  }, [id]);
  const reorderAreas = useCallback(
    async (ids: string[]) => {
      setAreaOrder(ids);
      await saveAreaOrder(id, ids);
    },
    [id],
  );

  if (inspection.isLoading || !inspection.data) {
    return (
      <SafeAreaView edges={['top']} className="flex-1 bg-background">
        <DetailSkeleton sections={3} />
      </SafeAreaView>
    );
  }

  const item = inspection.data;
  const roomList = applyAreaOrder(rooms.data ?? [], areaOrder);
  const findingList = findings.data ?? [];
  // pickUpNextArea outranks a plain "first unfinished": it surfaces failed
  // uploads and ready-to-complete areas ahead of untouched required work.
  const nextRoom = pickUpNextArea(roomList);
  const completedRooms = roomList.filter(isRoomDone).length;
  const progress = roomList.length ? Math.round((completedRooms / roomList.length) * 100) : 0;
  const pendingUploads = roomList.filter((room) =>
    ['PENDING', 'UPLOADING', 'PAUSED', 'FAILED'].includes(room.uploadStatus),
  ).length;
  // Only while the job is still the technician's to work on.
  const working = item.status === 'SCHEDULED' || item.status === 'IN_PROGRESS';
  const priorityItems = buildPriorityChecklist(findingList);
  const coverage = summaryCoverage(roomList, findingList);

  // Areas with nothing recorded, swept up in one go on the visits whose scope is
  // chosen (occupied, back-to-market): the rule is `bulkSkippableAreas`.
  const bulkSkip = bulkSkippableAreas(roomList, item.type, (room) => deriveAreaStatus(room).status);
  const notStarted = bulkSkip.skippable;
  const skipNotStarted = () => {
    const count = notStarted.length;
    Alert.alert(
      `Skip ${count} area${count === 1 ? '' : 's'}?`,
      [
        `${count} area${count === 1 ? ' has' : 's have'} nothing recorded against ${
          count === 1 ? 'it' : 'them'
        }. Skipping marks ${count === 1 ? 'it' : 'them'} as nothing to capture.`,
        // Named, not counted: skipping a required area is what lets the job end
        // without it, so the technician should be reading its name.
        bulkSkip.required.length
          ? `This includes ${bulkSkip.required.map((room) => room.name).join(', ')}, which ${
              bulkSkip.required.length === 1 ? 'is a required area' : 'are required areas'
            }.`
          : null,
      ]
        .filter(Boolean)
        .join('\n\n'),
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Skip them',
          style: bulkSkip.required.length ? 'destructive' : 'default',
          onPress: () =>
            skipAreas.mutate(
              notStarted.map((room) => room.id),
              {
                onSuccess: ({ failed }) => {
                  if (!failed.length) return;
                  Alert.alert(
                    'Some areas could not be skipped',
                    `${failed.length} area${failed.length === 1 ? '' : 's'} were left as they were. Open them to skip individually.`,
                  );
                },
              },
            ),
        },
      ],
    );
  };

  return (
    <SafeAreaView edges={['top']} className="flex-1 bg-background">
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingBottom: 120 }}
        // Off while a row is held, so one finger cannot scroll and rearrange at once.
        scrollEnabled={!draggingArea}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} tintColor={theme.primary} />}
      >
        <View className="flex-row items-center gap-3 px-5 pb-3 pt-2">
          <Pressable
            accessibilityLabel="Back to the job"
            accessibilityRole="button"
            className="h-9 w-9 items-center justify-center rounded-full bg-card active:scale-[0.98]"
            hitSlop={8}
            onPress={() => goBack()}
          >
            <BackGlyph size={18} className="text-foreground" />
          </Pressable>
          <View className="min-w-0 flex-1">
            <Text numberOfLines={1} className="text-lg font-bold text-foreground">
              {INSPECTION_TITLE[item.type] ?? 'Inspection'}
            </Text>
            <Text numberOfLines={1} className="text-xs text-muted-foreground">
              {item.property.address}
            </Text>
          </View>
          <HomeButton />
        </View>

        <View className="mx-5 gap-3 rounded-2xl bg-card p-5">
          <View className="flex-row items-center justify-between">
            <Text className="text-base font-semibold text-foreground">Progress</Text>
            <Text className="text-sm text-muted-foreground">
              {completedRooms} of {roomList.length} areas
            </Text>
          </View>
          <View className="h-2 overflow-hidden rounded-full bg-muted">
            <View className="h-full rounded-full bg-primary" style={{ width: `${progress}%` }} />
          </View>
          <View className="flex-row justify-between">
            <View className="flex-row items-center gap-1.5">
              <CameraIcon size={13} className="text-muted-foreground" />
              <Text className="text-xs text-muted-foreground">
                {roomList.filter((room) => room.completionStatus === 'RECORDING_SAVED').length} recordings saved
              </Text>
            </View>
            <View className="flex-row items-center gap-1.5">
              <FileTextIcon size={13} className="text-muted-foreground" />
              <Text className="text-xs text-muted-foreground">{findingList.length} findings</Text>
            </View>
            {pendingUploads ? (
              <View className="flex-row items-center gap-1.5">
                <View className="h-2 w-2 rounded-full bg-chart-1" />
                <Text className="text-xs text-chart-1">{pendingUploads} pending</Text>
              </View>
            ) : null}
          </View>
        </View>

        <View className="mt-5">
          <View className="mb-3 flex-row items-center justify-between px-5">
            <Text className="text-lg font-semibold text-foreground">Areas</Text>
            {working ? (
              <Pressable
                accessibilityHint="For a space that is not on the floor plan"
                accessibilityLabel="Add an area"
                accessibilityRole="button"
                className="min-h-11 flex-row items-center gap-1 rounded-full bg-primary/10 px-3"
                onPress={() => setAddAreaOpen(true)}
              >
                <PlusIcon size={14} className="text-primary" />
                <Text className="text-sm font-semibold text-primary">Add</Text>
              </Pressable>
            ) : null}
          </View>
          {rooms.isError ? (
            <Text className="mx-5 mb-3 rounded-xl bg-destructive/10 p-3 text-sm text-destructive">
              {rooms.error instanceof Error ? rooms.error.message : 'Could not load areas.'}
            </Text>
          ) : null}
          <ReorderableAreaList
            enabled={working}
            items={roomList}
            keyOf={(room) => room.id}
            onDragStateChange={setDraggingArea}
            onReorder={(ids) => void reorderAreas(ids)}
            renderItem={(room, { dragging }) => <RoomRow dragging={dragging} findings={findingList} room={room} />}
          />
          {/* Under the list: it acts on what the technician has just read, and a
              control that disposes of areas should not be the first thing offered. */}
          {bulkSkip.offered && item.status === 'IN_PROGRESS' ? (
            <Pressable
              accessibilityHint="Marks every area with nothing recorded against it as nothing to capture"
              accessibilityLabel={`Skip ${notStarted.length} not started area${notStarted.length === 1 ? '' : 's'}`}
              accessibilityRole="button"
              accessibilityState={{ disabled: skipAreas.isPending }}
              className="mx-5 mt-1 min-h-11 flex-row items-center justify-center gap-2 rounded-xl border border-border py-3 active:opacity-60"
              disabled={skipAreas.isPending}
              onPress={skipNotStarted}
            >
              <CircleIcon size={15} className="text-muted-foreground" />
              <Text className="text-sm font-semibold text-foreground">
                {skipAreas.isPending
                  ? 'Skipping…'
                  : `Skip ${notStarted.length} not started area${notStarted.length === 1 ? '' : 's'}`}
              </Text>
            </Pressable>
          ) : null}
        </View>

        {!roomList.length && !rooms.isLoading ? (
          // Two situations that look the same: a property whose areas nobody has
          // approved yet, and one the technician has been asked to survey.
          <View className="mx-5 mt-5 items-center gap-2 rounded-2xl bg-card p-5">
            <FileTextIcon size={28} className="text-muted-foreground" />
            {item.allowTechnicianAreaCapture ? (
              <>
                <Text className="text-sm font-semibold text-foreground">Add the areas as you walk the property</Text>
                <Text className="text-center text-sm text-muted-foreground">
                  This property has no floor plan yet, so you are building the list. Add each room or outdoor space as
                  you reach it, then record it as normal. What you add is saved to the property for an administrator to
                  approve.
                </Text>
                {working ? (
                  <Pressable
                    accessibilityHint="Starts the list for a property with no floor plan"
                    accessibilityLabel="Add the first area"
                    accessibilityRole="button"
                    className="mt-2 min-h-12 flex-row items-center gap-2 rounded-xl bg-primary px-5"
                    onPress={() => setAddAreaOpen(true)}
                  >
                    <PlusIcon size={16} className="text-primary-foreground" />
                    <Text className="font-semibold text-primary-foreground">Add the first area</Text>
                  </Pressable>
                ) : null}
              </>
            ) : (
              <>
                <Text className="text-sm font-semibold text-foreground">No approved areas available</Text>
                <Text className="text-center text-sm text-muted-foreground">
                  Contact an administrator to approve the property’s inspection areas.
                </Text>
              </>
            )}
          </View>
        ) : null}

        <PriorityAuditList
          coverage={coverage}
          items={priorityItems}
          onOpenArea={(roomId) => router.push(`/areas/${roomId}`)}
          onOpenFinding={(findingId) => router.push(`/findings/${findingId}?inspectionId=${id}`)}
        />

        <View className="mt-5">
          <Text className="mb-3 px-5 text-lg font-semibold text-foreground">Findings</Text>
          {findingList.length ? (
            findingList.slice(0, 4).map((finding) => (
              <View key={finding.id} className="mx-5 mb-2 gap-2 rounded-xl bg-card p-4">
                <View className="flex-row items-start justify-between">
                  <View className="mr-3 min-w-0 flex-1">
                    <Text className="text-sm font-semibold text-foreground">{finding.title}</Text>
                    <Text className="mt-0.5 text-xs text-muted-foreground">{finding.roomName}</Text>
                  </View>
                  <View
                    className={`flex-row items-center gap-1 rounded-full px-2.5 py-0.5 ${
                      finding.severity === 'HIGH'
                        ? 'bg-destructive/15'
                        : finding.severity === 'MEDIUM'
                          ? 'bg-chart-1/15'
                          : 'bg-chart-4/15'
                    }`}
                  >
                    <AlertTriangleIcon
                      size={10}
                      className={
                        finding.severity === 'HIGH'
                          ? 'text-destructive'
                          : finding.severity === 'MEDIUM'
                            ? 'text-chart-1'
                            : 'text-chart-4'
                      }
                    />
                    <Text
                      className={`text-xs font-semibold capitalize ${
                        finding.severity === 'HIGH'
                          ? 'text-destructive'
                          : finding.severity === 'MEDIUM'
                            ? 'text-chart-1'
                            : 'text-chart-4'
                      }`}
                    >
                      {finding.severity.toLowerCase()}
                    </Text>
                  </View>
                </View>
                <Text numberOfLines={2} className="text-xs leading-relaxed text-muted-foreground">
                  {finding.observation || finding.aiSummary}
                </Text>
              </View>
            ))
          ) : (
            <View className="mx-5 items-center gap-2 rounded-2xl bg-card p-5">
              <CheckCircle2Icon size={28} className="text-muted-foreground" />
              <Text className="text-sm text-muted-foreground">No findings documented yet</Text>
            </View>
          )}
        </View>
      </ScrollView>

      {working ? (
        <View className="absolute bottom-0 left-0 right-0 border-t border-border bg-background px-5 pb-8 pt-3">
          <Pressable
            accessibilityLabel={nextRoom ? `Continue to ${nextRoom.name}` : 'Back to the job'}
            accessibilityRole="button"
            className="min-h-12 items-center justify-center rounded-xl bg-primary py-3.5 active:scale-[0.98]"
            onPress={() => (nextRoom ? router.push(`/areas/${nextRoom.id}`) : goBack())}
          >
            <View className="flex-row items-center gap-2">
              {nextRoom ? <CameraIcon size={18} className="text-primary-foreground" /> : null}
              <Text className="text-base font-bold text-primary-foreground">
                {nextRoom ? `Continue: ${nextRoom.name}` : 'Done: back to the job'}
              </Text>
            </View>
          </Pressable>
        </View>
      ) : null}

      <AddAreaSheet
        inspectionId={id}
        visible={addAreaOpen}
        onClose={() => setAddAreaOpen(false)}
        // Straight into the new area: the technician is standing in it.
        onAdded={(roomId) => router.push(`/areas/${roomId}`)}
      />
    </SafeAreaView>
  );
}
