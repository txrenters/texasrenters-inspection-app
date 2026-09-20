import { useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  ClockIcon,
  FlagIcon,
  MapPinIcon,
  PlayCircleIcon,
} from 'lucide-react-native';
import { Alert, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { ReportableVisitService, VisitServicesReport } from '@texasrenters/shared';

import { EndJobSheet } from '@/src/components/EndJobSheet';
import { HomeButton } from '@/src/components/HomeButton';
import { JobFileCard } from '@/src/components/JobFileCard';
import { JobTasksCard } from '@/src/components/JobTasksCard';
import { NoAccessSheet } from '@/src/components/NoAccessSheet';
import { NotDoneSheet } from '@/src/components/NotDoneSheet';
import { StartJobSheet } from '@/src/components/StartJobSheet';
import { VisitDetailsCard } from '@/src/components/VisitDetailsCard';
import { BackGlyph } from '@/src/components/ui/BackGlyph';
import { DetailSkeleton } from '@/src/components/ui/Skeleton';
import { useInspection, useInspectionActions, useRooms } from '@/src/features/queries';
import { usePullToRefresh } from '@/src/features/usePullToRefresh';
import { useSecondNow } from '@/src/features/useSecondNow';
import { registerIcons } from '@/src/lib/icons';
import { goBack } from '@/src/lib/navigation';
import { useThemeColors } from '@/src/lib/theme-colors';
import { deriveAreaStatus } from '@/src/utils/area-status';
import {
  asksClosingComments,
  closingCommentsToSend,
  EMPTY_CLOSING_COMMENTS,
  type ClosingComments,
} from '@/src/utils/closing-comments';
import { planEndJob } from '@/src/utils/end-job';
import { formatTimer, formatWorked, jobElapsed } from '@/src/utils/job-clock';
import {
  jobChecklistProblems,
  jobTasks,
  toggledService,
  withServiceAnswer,
  type JobTask,
} from '@/src/utils/job-tasks';
import { INSPECTION_STATUS_TONE_CLASS, inspectionStatusPresentation } from '@/src/utils/inspection-status';
import { evaluateSubmissionGate } from '@/src/utils/submission-gate';
import { formatVisitWindow } from '@/src/utils/visit-window';

registerIcons(AlertTriangleIcon, CheckCircle2Icon, ClockIcon, FlagIcon, MapPinIcon, PlayCircleIcon);

/**
 * One job, in the steps the office asked for (2026-09-18):
 *
 * "once they click that property they should be able to see this screen start
 * job then if they confirm time tracker starts then the list of the jobs screen
 * appear -- Pest control just a check box, filter change can be clicked, then
 * inspection can be clicked also -- on the bottom of it there's an end job
 * button that submits the job."
 *
 * So a scheduled job shows the property, what is booked and the office's notes,
 * with Start job under them, confirmed before the timer starts. A started job
 * is its list and a running timer, with End job under it. End job is the
 * submission: it sends the technician back to anything unfinished, asks why for
 * a service left unticked, and submits once they confirm.
 */

/** What each kind of visit is called on the handset. */
const INSPECTION_TYPE_LABEL: Record<string, string> = {
  MOVE_IN: 'Move-in inspection',
  MOVE_OUT: 'Move-out inspection',
  OCCUPIED: 'Occupied inspection',
  BACK_TO_MARKET: 'Back-to-market inspection',
  // The office's own name for it, as its report is titled.
  HVAC: 'HVAC inspection',
  ROOF: 'Roof inspection',
  SUPRA_LOCKBOX_PLACEMENT: 'Lockbox placement',
  SUPRA_LOCKBOX_REMOVAL: 'Lockbox removal',
  AC_FILTER_DELIVERY: 'AC filter delivery',
};

const isService = (task: JobTask): task is JobTask & { key: ReportableVisitService } => task.key !== 'inspection';

export default function JobScreen() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const inspection = useInspection(id);
  const rooms = useRooms(id);
  const actions = useInspectionActions(id);
  const theme = useThemeColors();
  const pull = usePullToRefresh([inspection.refetch, rooms.refetch]);
  const [startOpen, setStartOpen] = useState(false);
  const [noAccessOpen, setNoAccessOpen] = useState(false);
  /** Services End job is asking about, one at a time, and the report as answered so far. */
  const [asking, setAsking] = useState<{ queue: JobTask[]; report: VisitServicesReport | null } | null>(null);
  /** The report End job is about to submit, while the technician confirms it. */
  const [ending, setEnding] = useState<{ report: VisitServicesReport | null } | null>(null);
  const [closingComments, setClosingComments] = useState<ClosingComments>(EMPTY_CLOSING_COMMENTS);
  const [endError, setEndError] = useState<string | null>(null);
  // Up here with the other hooks, above the early return below.
  const running = inspection.data?.status === 'IN_PROGRESS' && !inspection.data.submittedAt;
  const now = useSecondNow(running);

  if (inspection.isLoading || !inspection.data) {
    return (
      <SafeAreaView edges={['top']} className="flex-1 bg-background">
        <DetailSkeleton sections={3} />
      </SafeAreaView>
    );
  }

  const item = inspection.data;
  const roomList = rooms.data ?? [];
  const completedRooms = roomList.filter((room) => {
    const { status } = deriveAreaStatus(room);
    return status === 'COMPLETED' || status === 'SKIPPED';
  }).length;
  /** The job's list, as the office numbers it, from the visit's Details and its areas. */
  const tasks = jobTasks({
    visitDetails: item.visitDetails,
    inspectionType: item.type,
    report: item.servicesReport,
    areas: { completed: completedRooms, total: roomList.length },
  });
  const elapsed = jobElapsed(item, now);
  const status = inspectionStatusPresentation(item.status);

  const toggle = (task: JobTask) => {
    if (isService(task)) actions.saveServices.mutate(toggledService(item.servicesReport, task.key));
  };
  const open = (task: JobTask) => {
    if (task.kind === 'FILTERS') router.push(`/job-filters/${id}`);
    else if (task.kind === 'INSPECTION') router.push(`/job-inspection/${id}`);
  };

  /** The same rule the server runs, over the answers as they now stand, then the last confirmation. */
  const confirmEnd = (report: VisitServicesReport | null) => {
    const problems = jobChecklistProblems(item.visitDetails, report);
    if (problems.length) {
      Alert.alert('Not ready to end the job', problems[0]);
      return;
    }
    setEndError(null);
    setEnding({ report });
  };

  const endJob = () => {
    const plan = planEndJob(tasks, evaluateSubmissionGate(roomList, item.status));
    const first = plan.blockers[0];
    if (first) {
      Alert.alert(first.title, first.message, [
        { text: 'Not now', style: 'cancel' },
        {
          text: first.opens === 'INSPECTION' ? 'Open the inspection' : 'Open the filters',
          onPress: () => router.push(first.opens === 'INSPECTION' ? `/job-inspection/${id}` : `/job-filters/${id}`),
        },
      ]);
      return;
    }
    const report = item.servicesReport ?? null;
    if (plan.unticked.length) setAsking({ queue: plan.unticked, report });
    else confirmEnd(report);
  };

  /** A service left unticked, answered: not done, with the reason. The next one, or on to ending. */
  const answerUnticked = ({ reason, reschedule }: { reason: string; reschedule: boolean }) => {
    if (!asking) return;
    const [current, ...rest] = asking.queue;
    if (!current || !isService(current)) return;
    const report = withServiceAnswer(asking.report, current.key, { done: false, reason, reschedule });
    // Saved as it is answered, like a tick, so it is on the job even if ending waits.
    actions.saveServices.mutate(report);
    if (rest.length) setAsking({ queue: rest, report });
    else {
      setAsking(null);
      confirmEnd(report);
    }
  };

  const submit = () => {
    if (!ending) return;
    setEndError(null);
    actions.complete.mutate(
      {
        servicesReport: ending.report ?? undefined,
        closingComments: asksClosingComments(item.type) ? closingCommentsToSend(closingComments) : undefined,
      },
      {
        onSuccess: () => {
          setEnding(null);
          setClosingComments(EMPTY_CLOSING_COMMENTS);
          Alert.alert('Job ended', 'It is with the office. Any photos still sending keep uploading.', [
            { text: 'Done', onPress: () => router.replace('/(app)/(tabs)/inspections') },
          ]);
        },
        onError: (error) =>
          setEndError(error instanceof Error ? error.message : 'The job could not be ended. Try again.'),
      },
    );
  };

  // The job as End job will send it, for the sheet's summary.
  const endingTasks = ending
    ? jobTasks({
        visitDetails: item.visitDetails,
        inspectionType: item.type,
        report: ending.report,
        areas: { completed: completedRooms, total: roomList.length },
      })
    : tasks;

  return (
    <SafeAreaView edges={['top']} className="flex-1 bg-background">
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingBottom: 150 }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} tintColor={theme.primary} />}
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
          <Text numberOfLines={1} className="min-w-0 flex-1 text-lg font-bold text-foreground">
            Job
          </Text>
          <HomeButton />
        </View>

        <View className="mx-5 gap-3 rounded-2xl bg-card p-5">
          <View className="flex-row items-start gap-3">
            <View className="h-11 w-11 items-center justify-center rounded-xl bg-primary/10">
              <MapPinIcon size={20} className="text-primary" />
            </View>
            <View className="min-w-0 flex-1">
              <Text className="text-lg font-bold text-foreground">{item.property.address}</Text>
              {/* The kind of visit, first: an HVAC job and a move-out share an address and nothing else. */}
              <Text className="text-sm font-semibold text-primary">
                {INSPECTION_TYPE_LABEL[item.type] ?? item.type.replaceAll('_', ' ')}
              </Text>
              <Text className="text-sm text-muted-foreground">
                {item.unitName ?? 'Entire property'} · {item.property.cityStateZip}
              </Text>
            </View>
            <View className={`rounded-full px-3 py-1 ${INSPECTION_STATUS_TONE_CLASS[status.tone].bg}`}>
              <Text className={`text-xs font-semibold ${INSPECTION_STATUS_TONE_CLASS[status.tone].text}`}>
                {status.label}
              </Text>
            </View>
          </View>

          <View className="flex-row items-center gap-1.5">
            <ClockIcon size={14} className="text-muted-foreground" />
            {/* The window only when the office booked one: `scheduledAt` is a date. */}
            <Text className="text-xs text-muted-foreground">
              {new Date(item.scheduledAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              {formatVisitWindow(item) ? ` · ${formatVisitWindow(item)}` : ''}
            </Text>
          </View>

          {/* The time tracker: from the server's Start job stamp, to the second while it runs. */}
          {elapsed !== null ? (
            running ? (
              <View
                accessibilityLabel={`Timer running, ${formatWorked(elapsed / 60_000)} so far`}
                className="flex-row items-center gap-2 self-start rounded-full bg-chart-2/15 px-3 py-1.5"
              >
                <ClockIcon size={16} className="text-chart-2" />
                {/* Tabular digits, so the tracker does not jitter as the seconds change. */}
                <Text className="text-base font-bold text-chart-2" style={{ fontVariant: ['tabular-nums'] }}>
                  {formatTimer(elapsed)}
                </Text>
              </View>
            ) : (
              <View className="flex-row items-center gap-1.5">
                <CheckCircle2Icon size={14} className="text-chart-3" />
                <Text className="text-xs font-semibold text-chart-3">Took {formatWorked(elapsed / 60_000)}</Text>
              </View>
            )
          ) : null}

          {/* Why the office sent this back, styled as something to act on. */}
          {item.reopenReason ? (
            <View className="rounded-xl border border-chart-4/30 bg-chart-4/10 p-3">
              <Text className="text-xs font-semibold uppercase tracking-wide text-chart-4">Sent back by the office</Text>
              <Text className="mt-1 text-sm leading-relaxed text-foreground">{item.reopenReason}</Text>
            </View>
          ) : null}
          {item.propertyNotes ? (
            <View className="rounded-xl bg-muted p-3">
              <Text className="text-xs leading-relaxed text-muted-foreground">{item.propertyNotes}</Text>
            </View>
          ) : null}
        </View>

        {/* The job's list: what is booked before the start, the work itself after it. */}
        <JobTasksCard
          className="mx-5 mt-5"
          mode={item.status === 'SCHEDULED' ? 'preview' : item.status === 'IN_PROGRESS' ? 'working' : 'done'}
          onOpen={open}
          onToggle={toggle}
          tasks={tasks}
        />

        {/* The office's notes: the filters to bring and who to call, then its file on the property. */}
        <VisitDetailsCard className="mx-5 mt-5" details={item.visitDetails} title={item.visitTitle} />
        <JobFileCard className="mx-5 mt-5" file={item.onFile} lastVisit={item.lastVisit} />
      </ScrollView>

      <View className="absolute bottom-0 left-0 right-0 border-t border-border bg-background px-5 pb-8 pt-3">
        {/* The way out of a job nobody can get into: quiet, under the work itself. */}
        {item.status === 'SCHEDULED' || item.status === 'IN_PROGRESS' ? (
          <Pressable
            accessibilityHint="Ends this job and asks the office to book it again"
            accessibilityLabel="Could not get in"
            accessibilityRole="button"
            className="mb-2 min-h-9 items-center justify-center rounded-lg py-1.5 active:opacity-70"
            onPress={() => setNoAccessOpen(true)}
          >
            <Text className="text-xs font-semibold text-muted-foreground">Could not get in?</Text>
          </Pressable>
        ) : null}
        {item.status === 'SCHEDULED' ? (
          <Pressable
            accessibilityLabel="Start job"
            accessibilityRole="button"
            className="min-h-12 items-center justify-center rounded-xl bg-primary py-3.5 active:scale-[0.98]"
            onPress={() => setStartOpen(true)}
          >
            <View className="flex-row items-center gap-2">
              <PlayCircleIcon size={20} className="text-primary-foreground" />
              <Text className="text-base font-bold text-primary-foreground">Start job</Text>
            </View>
          </Pressable>
        ) : item.status === 'IN_PROGRESS' ? (
          <Pressable
            accessibilityHint="Submits the job to the office once everything is done"
            accessibilityLabel="End job"
            accessibilityRole="button"
            className="min-h-12 items-center justify-center rounded-xl bg-primary py-3.5 active:scale-[0.98]"
            onPress={endJob}
          >
            <View className="flex-row items-center gap-2">
              <FlagIcon size={18} className="text-primary-foreground" />
              <Text className="text-base font-bold text-primary-foreground">End job</Text>
            </View>
          </Pressable>
        ) : (
          // Every remaining status, and they do not all mean the same thing: a
          // follow-up is not finished work.
          (() => {
            const needsAttention = status.tone === 'attention';
            const StatusIcon = needsAttention ? AlertTriangleIcon : CheckCircle2Icon;
            return (
              <View className="flex-row items-center gap-3 rounded-xl bg-card p-4">
                <StatusIcon size={22} className={needsAttention ? 'text-destructive' : 'text-chart-3'} />
                <View className="flex-1">
                  <Text className="text-sm font-semibold text-foreground">
                    {needsAttention ? 'Follow-up Needed' : item.status === 'COMPLETED' ? 'Job Complete' : 'Submitted to Office'}
                  </Text>
                  <Text className="text-xs text-muted-foreground">
                    {needsAttention
                      ? 'The office has asked for another visit. They will reopen this when it is ready for you.'
                      : item.status === 'COMPLETED'
                        ? 'All approved evidence remains available for review'
                        : 'Your job is in. Nothing further is needed from you unless the office reopens it.'}
                  </Text>
                </View>
              </View>
            );
          })()
        )}
      </View>

      <StartJobSheet
        address={item.property.address}
        busy={actions.start.isPending}
        onClose={() => setStartOpen(false)}
        onStart={() =>
          actions.start.mutate(undefined, {
            // The job's list takes over the screen once it has started.
            onSettled: () => setStartOpen(false),
            onError: () =>
              Alert.alert('The job did not start', 'Check the connection and press Start job again.'),
          })
        }
        visible={startOpen}
      />

      <NotDoneSheet
        onClose={() => setAsking(null)}
        onSave={answerUnticked}
        title={asking?.queue[0]?.title ?? ''}
        visible={Boolean(asking?.queue.length)}
      />

      <EndJobSheet
        busy={actions.complete.isPending}
        comments={asksClosingComments(item.type) ? { draft: closingComments, onChange: setClosingComments } : undefined}
        error={endError}
        onClose={() => setEnding(null)}
        onEnd={submit}
        tasks={endingTasks}
        took={formatWorked((elapsed ?? 0) / 60_000)}
        visible={Boolean(ending)}
      />

      <NoAccessSheet
        busy={actions.couldNotAccess.isPending}
        onClose={() => setNoAccessOpen(false)}
        onReport={(reason) => actions.couldNotAccess.mutate(reason, { onSettled: () => setNoAccessOpen(false) })}
        visible={noAccessOpen}
      />
    </SafeAreaView>
  );
}
