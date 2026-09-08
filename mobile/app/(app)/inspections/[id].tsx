import { useCallback, useEffect, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import {
  AlertTriangleIcon,
  CameraIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleIcon,
  ClockIcon,
  FileTextIcon,
  MapPinIcon,
  PlayCircleIcon,
  PlusIcon,
  Settings2Icon,
} from 'lucide-react-native';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BackGlyph } from '@/src/components/ui/BackGlyph';
import { goBack } from '@/src/lib/navigation';
import type { Finding, InspectionRoom } from '@/src/domain/models';
import { useFindings, useInspection, useInspectionActions, useRooms } from '@/src/features/queries';
import { registerIcons } from '@/src/lib/icons';
import { formatVisitWindow } from '@/src/utils/visit-window';
import { applyAreaOrder, loadAreaOrder, saveAreaOrder } from '@/src/areas/area-order';
import { ReorderableAreaList } from '@/src/areas/ReorderableAreaList';
import { AddAreaSheet } from '@/src/components/AddAreaSheet';
import { HomeButton } from '@/src/components/HomeButton';
import { PriorityAuditList } from '@/src/components/PriorityAuditList';
import { DetailSkeleton } from '@/src/components/ui/Skeleton';
import { usePullToRefresh } from '@/src/features/usePullToRefresh';
import { useThemeColors } from '@/src/lib/theme-colors';
import { buildPriorityChecklist, summaryCoverage } from '@/src/utils/inspection-audit';
import {
  INSPECTION_STATUS_TONE_CLASS,
  inspectionStatusPresentation,
} from '@/src/utils/inspection-status';
import {
  deriveAreaStatus,
  pickUpNextArea,
  type AreaStatusDescriptor,
} from '@/src/utils/area-status';

registerIcons(
  AlertTriangleIcon,
  CameraIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleIcon,
  ClockIcon,
  FileTextIcon,
  MapPinIcon,
  PlayCircleIcon,
  PlusIcon,
  Settings2Icon,
);

function isRoomDone(room: InspectionRoom) {
  const { status } = deriveAreaStatus(room);
  return status === 'COMPLETED' || status === 'SKIPPED';
}

/**
 * What each kind of visit is called on the handset.
 *
 * Spelled out rather than de-underscored from the enum: "HVAC" should not
 * render as "Hvac", and "Back to market" reads better than "BACK TO MARKET"
 * shouted at a technician standing in someone's hallway.
 */
const INSPECTION_TYPE_LABEL: Record<string, string> = {
  MOVE_IN: 'Move-in inspection',
  MOVE_OUT: 'Move-out inspection',
  OCCUPIED: 'Occupied inspection',
  BACK_TO_MARKET: 'Back-to-market inspection',
  HVAC: 'HVAC service visit',
  ROOF: 'Roof inspection',
  SUPRA_LOCKBOX_PLACEMENT: 'Lockbox placement',
  SUPRA_LOCKBOX_REMOVAL: 'Lockbox removal',
  AC_FILTER_DELIVERY: 'AC filter delivery',
};

const TONE_TEXT: Record<AreaStatusDescriptor['tone'], string> = {
  neutral: 'text-muted-foreground',
  info: 'text-chart-2',
  progress: 'text-chart-2',
  success: 'text-chart-3',
  warning: 'text-chart-4',
  danger: 'text-destructive',
};

function RoomRow({
  room,
  findings,
  dragging = false,
}: {
  room: InspectionRoom;
  findings: Finding[];
  /** Held by the technician right now. Only changes how it looks — a lifted row
   * needs to read as picked up rather than merely selected. */
  dragging?: boolean;
}) {
  // Derived rather than open-coded: a failed upload now surfaces on this row
  // instead of reading as "not started", which is the one state a technician
  // has to act on before leaving the property.
  const derived = deriveAreaStatus(room);
  const done = derived.status === 'COMPLETED' || derived.status === 'SKIPPED';
  const active = derived.status !== 'NOT_STARTED' && !done;
  const roomFindings = findings.filter((finding) => finding.roomId === room.id);
  return (
    <Pressable
      // Status is otherwise conveyed only by a coloured bar and an icon, both
      // invisible to a screen reader — it has to be said in words.
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
        // No press-scale while held: the row is already lifted by the drag, and
        // two competing transforms read as a glitch.
        dragging ? 'border border-primary/40 shadow-lg' : 'active:scale-[0.98]'
      }`}
      onPress={() => router.push(`/areas/${room.id}`)}
    >
      <View importantForAccessibility="no-hide-descendants" className="flex-row items-center">
        <View
          className={`w-1.5 self-stretch ${
            derived.needsAttention
              ? 'bg-chart-4'
              : done
                ? 'bg-chart-3'
                : active
                  ? 'bg-chart-2'
                  : 'bg-muted'
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
            {/* Status in words as well as colour. */}
            <Text className={`mt-0.5 text-xs font-medium ${TONE_TEXT[derived.tone]}`}>
              {derived.label}
            </Text>
            {room.baseline?.summary ? (
              <Text
                numberOfLines={2}
                className="mt-1 text-xs leading-relaxed text-muted-foreground"
              >
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

export default function InspectionOverviewScreen() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const inspection = useInspection(id);
  const rooms = useRooms(id);
  const findings = useFindings(id);
  const actions = useInspectionActions(id);
  const theme = useThemeColors();
  const pull = usePullToRefresh([inspection.refetch, rooms.refetch, findings.refetch]);
  const [addAreaOpen, setAddAreaOpen] = useState(false);

  /**
   * The technician's own sequence for this inspection, if they have set one.
   *
   * Up here with the other hooks, above the early returns below. A hook placed
   * after one runs on some renders and not others, React counts a different
   * number each time, and the whole screen goes down with error #310 — the
   * same trap the import prompt fell into on the console's detail page.
   *
   * Applied by rewriting `order` rather than sorting here, because three
   * separate places sort by it — this list, "Up next", and the room the camera
   * advances to after a capture. Sorting in one would leave somebody looking at
   * their order while the app kept offering the server's.
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
      // Applied immediately and persisted after. A reorder that waited on
      // storage would feel broken on a slow handset, and the write is one small
      // key — there is nothing to roll back if it fails.
      setAreaOrder(ids);
      await saveAreaOrder(id, ids);
    },
    [id],
  );

  if (inspection.isLoading || !inspection.data) {
    return (
      <SafeAreaView edges={['top']} className="flex-1 bg-background">
        <DetailSkeleton sections={4} />
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
  // Only while the inspection is still the technician's to work on. Once it is
  // submitted the evidence set is fixed, and adding an area then would mean
  // handing review a room nobody captured.
  const canAddArea = item.status === 'SCHEDULED' || item.status === 'IN_PROGRESS';
  // The audit ordered by what still needs attention, plus the areas that
  // finished without the AI producing anything — a gap the pipeline cannot
  // report on itself.
  const priorityItems = buildPriorityChecklist(findingList);
  const coverage = summaryCoverage(roomList, findingList);

  return (
    <SafeAreaView edges={['top']} className="flex-1 bg-background">
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingBottom: 132 }}
        // Off while a row is held, so a single finger cannot scroll the list and
        // rearrange it at the same time.
        scrollEnabled={!draggingArea}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={pull.refreshing}
            onRefresh={pull.onRefresh}
            tintColor={theme.primary}
          />
        }
      >
        <View className="flex-row items-center gap-3 px-5 pb-3 pt-2">
          <Pressable
            accessibilityLabel="Back"
            accessibilityRole="button"
            className="h-9 w-9 items-center justify-center rounded-full bg-card active:scale-[0.98]"
            hitSlop={8}
            onPress={() => goBack()}
          >
            <BackGlyph size={18} className="text-foreground" />
          </Pressable>
          <View className="min-w-0 flex-1">
            <Text numberOfLines={1} className="text-lg font-bold text-foreground">
              Inspection Overview
            </Text>
          </View>
          <HomeButton />
        </View>

        <View className="mx-5 gap-3 rounded-2xl bg-card p-5">
          <View className="flex-row items-start gap-3">
            <View className="h-11 w-11 items-center justify-center rounded-xl bg-primary/10">
              <MapPinIcon size={20} className="text-primary" />
            </View>
            <View className="min-w-0 flex-1">
              <Text className="text-lg font-bold text-foreground">{item.property.address}</Text>
              {/* The kind of visit, first. It decides what the technician is
                  being asked to do — an HVAC job and a move-out share an
                  address and nothing else — and the screen previously named
                  only the unit, so the two were indistinguishable. */}
              <Text className="text-sm font-semibold text-primary">
                {INSPECTION_TYPE_LABEL[item.type] ?? item.type.replaceAll('_', ' ')}
              </Text>
              <Text className="text-sm text-muted-foreground">
                {item.unitName ?? 'Entire property'} · {item.property.cityStateZip}
              </Text>
            </View>
            <View
              className={`rounded-full px-3 py-1 ${
                INSPECTION_STATUS_TONE_CLASS[inspectionStatusPresentation(item.status).tone].bg
              }`}
            >
              {/* Not `capitalize`: the label is already cased, and forcing it
                  turned "With Office" into something a stylesheet chose. */}
              <Text
                className={`text-xs font-semibold ${
                  INSPECTION_STATUS_TONE_CLASS[inspectionStatusPresentation(item.status).tone].text
                }`}
              >
                {inspectionStatusPresentation(item.status).label}
              </Text>
            </View>
          </View>
          <View className="flex-row flex-wrap gap-4">
            <View className="flex-row items-center gap-1.5">
              <ClockIcon size={14} className="text-muted-foreground" />
              {/* The hour used to be formatted out of `scheduledAt`, which is a
                  date — so this line read "12:00 AM" on every inspection. The
                  window is shown only when the office actually booked one. */}
              <Text className="text-xs text-muted-foreground">
                {new Date(item.scheduledAt).toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                })}
                {formatVisitWindow(item) ? ` · ${formatVisitWindow(item)}` : ''}
              </Text>
            </View>
            <Text className="text-xs capitalize text-muted-foreground">
              · {item.type.replaceAll('_', ' ').toLowerCase()}
            </Text>
          </View>
          {/* Why the office sent this back, above the property notes and styled
              as something to act on rather than background. Before this the
              reason lived only in the audit log, so a reopened inspection
              reappeared in the queue with no explanation at all. */}
          {item.reopenReason ? (
            <View className="rounded-xl border border-chart-4/30 bg-chart-4/10 p-3">
              <Text className="text-xs font-semibold uppercase tracking-wide text-chart-4">
                Sent back by the office
              </Text>
              <Text className="mt-1 text-sm leading-relaxed text-foreground">
                {item.reopenReason}
              </Text>
            </View>
          ) : null}
          {item.propertyNotes ? (
            <View className="rounded-xl bg-muted p-3">
              <Text className="text-xs leading-relaxed text-muted-foreground">
                {item.propertyNotes}
              </Text>
            </View>
          ) : null}
        </View>

        <View className="mx-5 mt-5 gap-3 rounded-2xl bg-card p-5">
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
                {roomList.filter((room) => room.completionStatus === 'RECORDING_SAVED').length}{' '}
                recordings saved
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
            <View className="flex-row items-center gap-3">
              <Text className="text-sm text-muted-foreground">{roomList.length} total</Text>
              {canAddArea ? (
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
          </View>
          {rooms.isError ? (
            <Text className="mx-5 mb-3 rounded-xl bg-destructive/10 p-3 text-sm text-destructive">
              {rooms.error instanceof Error ? rooms.error.message : 'Could not load areas.'}
            </Text>
          ) : null}
          {/*
            Reorderable while the inspection is still the technician's to work.
            Once it is submitted the sequence is history, and letting somebody
            shuffle a finished list would imply it still meant something.

            The order is theirs alone — stored on this handset, never sent to
            the server, and it does not touch the property layout the office
            approved. What it does change is what the app offers next, which is
            the point: a technician who decides to start upstairs should not be
            sent back down by "Up next".
          */}
          <ReorderableAreaList
            enabled={canAddArea}
            items={roomList}
            keyOf={(room) => room.id}
            onDragStateChange={setDraggingArea}
            onReorder={(ids) => void reorderAreas(ids)}
            renderItem={(room, { dragging }) => (
              <RoomRow dragging={dragging} findings={findingList} room={room} />
            )}
          />
        </View>

        {!roomList.length && !rooms.isLoading ? (
          // Two different situations that look identical: a property whose
          // areas nobody has approved yet, and one the administrator has asked
          // this technician to survey. Telling the second to contact an
          // administrator sends them back to the person who just asked them.
          <View className="mx-5 mt-5 items-center gap-2 rounded-2xl bg-card p-5">
            <FileTextIcon size={28} className="text-muted-foreground" />
            {item.allowTechnicianAreaCapture ? (
              <>
                <Text className="text-sm font-semibold text-foreground">
                  Add the areas as you walk the property
                </Text>
                <Text className="text-center text-sm text-muted-foreground">
                  This property has no floor plan yet, so you are building the list. Add each room
                  or outdoor space as you reach it, then record it as normal. What you add is saved
                  to the property for an administrator to approve.
                </Text>
                {canAddArea ? (
                  <Pressable
                    accessibilityHint="Starts the list for a property with no floor plan"
                    accessibilityLabel="Add the first area"
                    accessibilityRole="button"
                    className="mt-2 min-h-12 flex-row items-center gap-2 rounded-xl bg-primary px-5"
                    onPress={() => setAddAreaOpen(true)}
                  >
                    <PlusIcon size={16} className="text-primary-foreground" />
                    <Text className="font-semibold text-primary-foreground">
                      Add the first area
                    </Text>
                  </Pressable>
                ) : null}
              </>
            ) : (
              <>
                <Text className="text-sm font-semibold text-foreground">
                  No approved areas available
                </Text>
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

      <View className="absolute bottom-0 left-0 right-0 border-t border-border bg-background px-5 pb-8 pt-3">
        {item.status === 'SCHEDULED' ? (
          <Pressable
            accessibilityLabel={
              actions.start.isPending ? 'Starting inspection' : 'Start inspection'
            }
            accessibilityRole="button"
            accessibilityState={{
              busy: actions.start.isPending,
              disabled: actions.start.isPending,
            }}
            className="min-h-12 items-center justify-center rounded-xl bg-primary py-3.5 active:scale-[0.98]"
            disabled={actions.start.isPending}
            onPress={() =>
              actions.start.mutate(undefined, {
                onSuccess: () => {
                  if (nextRoom) router.push(`/areas/${nextRoom.id}`);
                },
              })
            }
          >
            <View className="flex-row items-center gap-2">
              <PlayCircleIcon size={20} className="text-primary-foreground" />
              <Text className="text-base font-bold text-primary-foreground">
                {actions.start.isPending ? 'Starting…' : 'Start Inspection'}
              </Text>
            </View>
          </Pressable>
        ) : item.status === 'IN_PROGRESS' ? (
          <View className="flex-row gap-3">
            <Pressable
              accessibilityLabel={
                nextRoom ? `Continue to ${nextRoom.name}` : 'Go to review and submit'
              }
              accessibilityRole="button"
              className="min-h-12 flex-1 items-center justify-center rounded-xl bg-primary py-3.5 active:scale-[0.98]"
              onPress={() =>
                nextRoom ? router.push(`/areas/${nextRoom.id}`) : router.push(`/review/${id}`)
              }
            >
              <View className="flex-row items-center gap-2">
                <CameraIcon size={18} className="text-primary-foreground" />
                <Text className="text-sm font-bold text-primary-foreground">
                  {nextRoom ? 'Continue' : 'Review'}
                </Text>
              </View>
            </Pressable>
            <Pressable
              accessibilityLabel="Review and submit"
              accessibilityRole="button"
              className="min-h-12 flex-1 items-center justify-center rounded-xl border border-border bg-card py-3.5 active:scale-[0.98]"
              onPress={() => router.push(`/review/${id}`)}
            >
              <Text className="text-sm font-bold text-foreground">Review & Submit</Text>
            </Pressable>
          </View>
        ) : (
          // Every remaining status, and they do not all mean the same thing.
          // This said "Inspection Complete" for all eight — including
          // FOLLOW_UP_REQUIRED, so the screen showed a red "Follow-up Needed"
          // pill at the top and declared the work finished at the bottom.
          (() => {
            const presentation = inspectionStatusPresentation(item.status);
            const needsAttention = presentation.tone === 'attention';
            const StatusIcon = needsAttention ? AlertTriangleIcon : CheckCircle2Icon;
            return (
              <View className="flex-row items-center gap-3 rounded-xl bg-card p-4">
                <StatusIcon
                  size={22}
                  className={needsAttention ? 'text-destructive' : 'text-chart-3'}
                />
                <View className="flex-1">
                  <Text className="text-sm font-semibold text-foreground">
                    {needsAttention
                      ? 'Follow-up Needed'
                      : item.status === 'COMPLETED'
                        ? 'Inspection Complete'
                        : 'Submitted to Office'}
                  </Text>
                  <Text className="text-xs text-muted-foreground">
                    {needsAttention
                      ? 'The office has asked for another visit. They will reopen this when it is ready for you.'
                      : item.status === 'COMPLETED'
                        ? 'All approved evidence remains available for review'
                        : 'Your capture is in. Nothing further is needed from you unless the office reopens it.'}
                  </Text>
                </View>
              </View>
            );
          })()
        )}
      </View>

      <AddAreaSheet
        inspectionId={id}
        visible={addAreaOpen}
        onClose={() => setAddAreaOpen(false)}
        // Straight into the new area: the technician is standing in the room
        // they just added, and the point of adding it here is to start
        // recording without waiting on anyone.
        onAdded={(roomId) => router.push(`/areas/${roomId}`)}
      />
    </SafeAreaView>
  );
}
