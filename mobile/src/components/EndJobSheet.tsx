import { MAX_VISIT_NOTE } from '@texasrenters/shared';
import { CheckCircle2Icon, XCircleIcon } from 'lucide-react-native';
import { ScrollView, Text, TextInput, View } from 'react-native';

import { BottomSheet } from '@/src/components/BottomSheet';
import { ClosingCommentsCard } from '@/src/components/ClosingCommentsCard';
import { Button } from '@/src/components/ui';
import { registerIcons } from '@/src/lib/icons';
import { useThemeColors } from '@/src/lib/theme-colors';
import type { ClosingComments } from '@/src/utils/closing-comments';
import type { JobTask } from '@/src/utils/job-tasks';

registerIcons(CheckCircle2Icon, XCircleIcon);

/** What each row says it came to. */
function outcome(task: JobTask) {
  if (task.state === 'NOT_DONE') return task.detail ? `Not done · ${task.detail}` : 'Not done';
  return task.detail ?? 'Done';
}

/**
 * The last step of a job: End job, confirmed (the office, 2026-09-18: "an end
 * job button that submits the job").
 *
 * It sums the job up as it goes to the office -- each row and what it came to,
 * and how long it took -- because this is the submission: once ended, the job
 * is the office's. An HVAC report's closing comments are written here too; they
 * are optional, and the office can edit them afterwards.
 *
 * So is a note for the office, on every job (the office, 2026-11-06). Until now
 * a technician could only write a reason for something not done, or a note on a
 * room: anything else about the visit had nowhere to go. It goes to the job page
 * and the Jobber note, never on the report a tenant and an owner read.
 */
export function EndJobSheet({
  visible,
  busy = false,
  tasks,
  took,
  note,
  comments,
  error,
  onClose,
  onEnd,
}: {
  visible: boolean;
  busy?: boolean;
  tasks: JobTask[];
  /** "42 min". */
  took: string;
  /** The note for the office. */
  note: { draft: string; onChange: (next: string) => void };
  /** An HVAC job's closing comments; absent for every other kind. */
  comments?: { draft: ClosingComments; onChange: (next: ClosingComments) => void };
  /** Why the last try did not go through. */
  error?: string | null;
  onClose: () => void;
  onEnd: () => void;
}) {
  const theme = useThemeColors();
  return (
    <BottomSheet accessibilityRole="alert" className="max-h-[92%]" onClose={onClose} visible={visible}>
      <ScrollView contentContainerStyle={{ gap: 16 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <View className="gap-1">
          <Text className="text-lg font-bold text-foreground">End this job?</Text>
          <Text className="text-sm text-muted-foreground">
            Took {took}. It goes to the office, and any photos still sending keep uploading.
          </Text>
        </View>

        <View className="gap-2">
          {tasks.map((task) => {
            const done = task.state === 'DONE';
            return (
              <View
                accessibilityLabel={`${task.title}: ${outcome(task)}`}
                className="flex-row items-center gap-3"
                key={task.key}
              >
                {done ? (
                  <CheckCircle2Icon size={18} className="text-chart-3" />
                ) : (
                  <XCircleIcon size={18} className="text-chart-4" />
                )}
                <Text className="text-sm font-medium text-foreground">{task.title}</Text>
                <Text className="min-w-0 flex-1 text-right text-xs text-muted-foreground" numberOfLines={2}>
                  {outcome(task)}
                </Text>
              </View>
            );
          })}
        </View>

        <View className="gap-1">
          <Text
            className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
            nativeID="job-note"
          >
            Note for the office
          </Text>
          <TextInput
            accessibilityLabel="Note for the office, optional"
            accessibilityLabelledBy="job-note"
            className="min-h-20 rounded-xl border border-border bg-background px-4 py-3 text-foreground"
            maxLength={MAX_VISIT_NOTE}
            multiline
            onChangeText={note.onChange}
            placeholder="Anything else they should know…"
            placeholderTextColor={theme.mutedForeground}
            textAlignVertical="top"
            value={note.draft}
          />
          <Text className="text-xs text-muted-foreground">Optional. Not printed on the report.</Text>
        </View>

        {comments ? <ClosingCommentsCard draft={comments.draft} onChange={comments.onChange} /> : null}

        {error ? (
          <Text accessibilityRole="alert" className="text-sm text-destructive">
            {error}
          </Text>
        ) : null}

        <View className="gap-3">
          <Button busy={busy} busyLabel="Ending…" label="End job" onPress={onEnd} />
          <Button disabled={busy} label="Keep working" onPress={onClose} variant="secondary" />
        </View>
      </ScrollView>
    </BottomSheet>
  );
}
