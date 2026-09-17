import { CameraIcon, CheckCircle2Icon, ChevronRightIcon, CircleIcon, XCircleIcon } from 'lucide-react-native';
import { Pressable, Text, View } from 'react-native';

import { Card, PRESS_ROW } from '@/src/components/ui';
import { registerIcons } from '@/src/lib/icons';
import type { JobTask, JobTaskState } from '@/src/utils/job-tasks';

registerIcons(CameraIcon, CheckCircle2Icon, ChevronRightIcon, CircleIcon, XCircleIcon);

/**
 * The job's checklist, ticked as the work happens.
 *
 * The office numbers this list on every benefit-package visit — "1.Filter
 * Change 2.Pest Control 3.HVAC / Occupied Inspection" — and asked for it on
 * the phone at the start of the job rather than remembered at the end (the
 * office, 2026-09-18). The numbers are theirs, so a technician reading Jobber
 * and a technician reading this see the same list.
 *
 * Each row opens what answering it needs: the filter registers with their
 * photographs, a sheet for a service that is one answer, and the areas for the
 * inspection itself.
 */

const STATE_TONE: Record<JobTaskState, { text: string; ring: string }> = {
  TODO: { text: 'text-muted-foreground', ring: 'border-border' },
  PART: { text: 'text-chart-2', ring: 'border-chart-2/40' },
  DONE: { text: 'text-chart-3', ring: 'border-chart-3/40' },
  NOT_DONE: { text: 'text-chart-4', ring: 'border-chart-4/40' },
};

const STATE_WORD: Record<JobTaskState, string> = {
  TODO: 'Not started',
  PART: 'In progress',
  DONE: 'Done',
  NOT_DONE: 'Not done',
};

function StateGlyph({ state }: { state: JobTaskState }) {
  if (state === 'DONE') return <CheckCircle2Icon size={20} className="text-chart-3" />;
  if (state === 'NOT_DONE') return <XCircleIcon size={20} className="text-chart-4" />;
  if (state === 'PART') return <CameraIcon size={18} className="text-chart-2" />;
  return <CircleIcon size={18} className="text-muted-foreground" />;
}

export function JobTasksCard({
  tasks,
  onOpen,
  disabled = false,
  className = '',
}: {
  tasks: JobTask[];
  onOpen: (task: JobTask) => void;
  /** Before the job is started there is nothing to answer yet. */
  disabled?: boolean;
  className?: string;
}) {
  if (!tasks.length) return null;

  return (
    <Card className={`gap-3 ${className}`}>
      <View className="gap-1">
        <Text className="text-base font-semibold text-foreground">This job</Text>
        <Text className="text-sm text-muted-foreground">
          {disabled ? 'Start the job to tick these off.' : 'Tick each one as you do it.'}
        </Text>
      </View>

      <View className="gap-2">
        {tasks.map((task) => {
          const tone = STATE_TONE[task.state];
          return (
            <Pressable
              accessibilityHint={
                task.kind === 'INSPECTION'
                  ? 'Opens the areas to inspect'
                  : task.kind === 'FILTERS'
                    ? 'Opens the filters to photograph'
                    : 'Marks this service done or not done'
              }
              // Status is a colour and a glyph otherwise, neither of which a
              // screen reader can see.
              accessibilityLabel={[
                task.number ? `${task.number}.` : '',
                task.title,
                STATE_WORD[task.state],
                task.detail,
              ]
                .filter(Boolean)
                .join(', ')}
              accessibilityRole="button"
              accessibilityState={{ disabled }}
              className={`min-h-14 flex-row items-center gap-3 rounded-xl border bg-card px-3 py-3 ${tone.ring} ${
                disabled ? 'opacity-50' : PRESS_ROW
              }`}
              disabled={disabled}
              key={task.key}
              onPress={() => onOpen(task)}
            >
              <View importantForAccessibility="no-hide-descendants" className="flex-row items-center gap-3">
                <StateGlyph state={task.state} />
              </View>
              <View importantForAccessibility="no-hide-descendants" className="min-w-0 flex-1">
                <Text className="text-sm font-semibold text-foreground">
                  {task.number ? `${task.number}. ` : ''}
                  {task.title}
                </Text>
                <Text className={`mt-0.5 text-xs ${tone.text}`}>
                  {task.detail ?? STATE_WORD[task.state]}
                </Text>
              </View>
              <ChevronRightIcon
                importantForAccessibility="no-hide-descendants"
                size={16}
                className="text-muted-foreground"
              />
            </Pressable>
          );
        })}
      </View>
    </Card>
  );
}
