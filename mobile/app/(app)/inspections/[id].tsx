import { useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { useColorScheme } from 'nativewind';
import {
  AlertTriangleIcon,
  ArrowLeftIcon,
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

import type { Finding, InspectionRoom } from '@/src/domain/models';
import { useFindings, useInspection, useInspectionActions, useRooms } from '@/src/features/queries';
import { registerIcons } from '@/src/lib/icons';
import { AddAreaSheet } from '@/src/components/AddAreaSheet';
import { HomeButton } from '@/src/components/HomeButton';
import { PriorityAuditList } from '@/src/components/PriorityAuditList';
import { DetailSkeleton } from '@/src/components/ui/Skeleton';
import { usePullToRefresh } from '@/src/features/usePullToRefresh';
import { buildPriorityChecklist, summaryCoverage } from '@/src/utils/inspection-audit';
import {
  deriveAreaStatus,
  pickUpNextArea,
  type AreaStatusDescriptor,
} from '@/src/utils/area-status';

registerIcons(
  AlertTriangleIcon,
  ArrowLeftIcon,
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

const TONE_TEXT: Record<AreaStatusDescriptor['tone'], string> = {
  neutral: 'text-muted-foreground',
  info: 'text-chart-2',
  progress: 'text-chart-2',
  success: 'text-chart-3',
  warning: 'text-chart-4',
  danger: 'text-destructive',
};

function RoomRow({ room, findings }: { room: InspectionRoom; findings: Finding[] }) {
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
      accessibilityHint="Opens this area"
      className="mx-5 mb-2 min-h-14 overflow-hidden rounded-xl bg-card active:scale-[0.98]"
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
            {room.baseline.summary ? (
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
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const pull = usePullToRefresh([inspection.refetch, rooms.refetch, findings.refetch]);
  const [addAreaOpen, setAddAreaOpen] = useState(false);

  if (inspection.isLoading || !inspection.data) {
    return (
      <SafeAreaView edges={['top']} className="flex-1 bg-background">
        <DetailSkeleton sections={4} />
      </SafeAreaView>
    );
  }

  const item = inspection.data;
  const roomList = rooms.data ?? [];
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
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={pull.refreshing}
            onRefresh={pull.onRefresh}
            tintColor={isDark ? '#2dd4bf' : '#145347'}
          />
        }
      >
        <View className="flex-row items-center gap-3 px-5 pb-3 pt-2">
          <Pressable
            accessibilityLabel="Back"
            accessibilityRole="button"
            className="h-9 w-9 items-center justify-center rounded-full bg-card active:scale-[0.95]"
            hitSlop={8}
            onPress={() => router.back()}
          >
            <ArrowLeftIcon size={18} className="text-foreground" />
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
              <Text className="text-sm text-muted-foreground">
                {item.unitName ?? 'Entire property'} · {item.property.cityStateZip}
              </Text>
            </View>
            <View
              className={`rounded-full px-3 py-1 ${
                item.status === 'IN_PROGRESS'
                  ? 'bg-chart-2/15'
                  : item.status === 'COMPLETED'
                    ? 'bg-chart-3/15'
                    : 'bg-chart-4/15'
              }`}
            >
              <Text
                className={`text-xs font-semibold capitalize ${
                  item.status === 'IN_PROGRESS'
                    ? 'text-chart-2'
                    : item.status === 'COMPLETED'
                      ? 'text-chart-3'
                      : 'text-chart-4'
                }`}
              >
                {item.status.replaceAll('_', ' ').toLowerCase()}
              </Text>
            </View>
          </View>
          <View className="flex-row flex-wrap gap-4">
            <View className="flex-row items-center gap-1.5">
              <ClockIcon size={14} className="text-muted-foreground" />
              <Text className="text-xs text-muted-foreground">
                {new Date(item.scheduledAt).toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </Text>
            </View>
            <Text className="text-xs capitalize text-muted-foreground">
              · {item.type.replaceAll('_', ' ').toLowerCase()}
            </Text>
          </View>
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
          {roomList.map((room) => (
            <RoomRow key={room.id} room={room} findings={findingList} />
          ))}
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
                    <Text className="font-semibold text-primary-foreground">Add the first area</Text>
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
          onOpenFinding={(findingId) =>
            router.push(`/findings/${findingId}?inspectionId=${id}`)
          }
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
          <View className="flex-row items-center gap-3 rounded-xl bg-card p-4">
            <CheckCircle2Icon size={22} className="text-chart-3" />
            <View className="flex-1">
              <Text className="text-sm font-semibold text-foreground">Inspection Complete</Text>
              <Text className="text-xs text-muted-foreground">
                All approved evidence remains available for review
              </Text>
            </View>
          </View>
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
