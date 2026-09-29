import { CameraIcon, CheckCircle2Icon, CheckIcon, ChevronRightIcon, CircleIcon, XCircleIcon } from 'lucide-react-native';
import { Pressable, Text, View } from 'react-native';

import { Card, PRESS_ROW } from '@/src/components/ui';
import { registerIcons } from '@/src/lib/icons';
import type { JobTask, JobTaskState } from '@/src/utils/job-tasks';

registerIcons(CameraIcon, CheckCircle2Icon, CheckIcon, ChevronRightIcon, CircleIcon, XCircleIcon);

/**
 * The job's list, worked through after Start job (the office, 2026-09-18).
 *
 * The owner's own words: "Pest control just a check box, filter change can be
 * clicked, then inspection can be clicked also". So a service that is one
 * answer -- pest control, a flea treatment -- is a checkbox ticked in place,
 * and the filter change and the inspection are rows that open their own
 * screens. The office numbers this list on every benefit-package visit -- "1.
 * Filter Change 2. Pest Control 3. HVAC / Occupied Inspection" -- and the
 * numbers are kept, so the phone and Jobber read alike.
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

const titleOf = (task: JobTask) => `${task.number ? `${task.number}. ` : ''}${task.title}`;

/**
 * A service that is one answer: a box to tick, and "Not done" beside it for a
 * note to the office (2026-09-29) -- say, pest control left for another day
 * while the filters and the inspection were done.
 */
function CheckboxRow({
  task,
  disabled,
  onToggle,
  onNotDone,
}: {
  task: JobTask;
  disabled: boolean;
  onToggle: () => void;
  onNotDone: () => void;
}) {
  const checked = task.state === 'DONE';
  const notDone = task.state === 'NOT_DONE';
  return (
    <View
      className={`min-h-14 flex-row items-center rounded-xl border bg-card ${
        checked ? 'border-primary/40' : notDone ? 'border-chart-4/40' : 'border-border'
      } ${disabled ? 'opacity-50' : ''}`}
    >
      <Pressable
        accessibilityHint={checked ? 'Unticks it' : 'Ticks it done'}
        accessibilityLabel={[titleOf(task), notDone ? `Not done, ${task.detail ?? ''}` : ''].filter(Boolean).join(', ')}
        accessibilityRole="checkbox"
        accessibilityState={{ checked, disabled }}
        className={`min-h-14 min-w-0 flex-1 flex-row items-center gap-3 rounded-xl px-3 py-3 ${disabled ? '' : PRESS_ROW}`}
        disabled={disabled}
        onPress={onToggle}
      >
        <View
          importantForAccessibility="no-hide-descendants"
          className={`h-6 w-6 items-center justify-center rounded-md ${
            checked ? 'bg-primary' : 'border-2 border-muted-foreground'
          }`}
        >
          {checked ? <CheckIcon size={16} className="text-primary-foreground" /> : null}
        </View>
        <View importantForAccessibility="no-hide-descendants" className="min-w-0 flex-1">
          <Text className="text-base font-semibold text-foreground">{titleOf(task)}</Text>
          {notDone ? (
            <Text numberOfLines={2} className="mt-0.5 text-xs text-chart-4">
              Not done · {task.detail}
            </Text>
          ) : null}
        </View>
      </Pressable>
      {/* Not offered once ticked: a done service has nothing to explain. */}
      {checked ? null : (
        <Pressable
          accessibilityHint="Say why it was not done, with a note for the office"
          accessibilityLabel={notDone ? `Change the note on ${task.title}` : `${task.title} not done`}
          accessibilityRole="button"
          accessibilityState={{ disabled }}
          className={`min-h-14 justify-center px-3 ${disabled ? '' : 'active:opacity-70'}`}
          disabled={disabled}
          onPress={onNotDone}
        >
          <Text className="text-xs font-semibold text-muted-foreground">{notDone ? 'Edit note' : 'Not done'}</Text>
        </Pressable>
      )}
    </View>
  );
}

/** The filter change or the inspection: a row that opens its own screen. */
function OpenRow({ task, disabled, onOpen }: { task: JobTask; disabled: boolean; onOpen: () => void }) {
  const tone = STATE_TONE[task.state];
  return (
    <Pressable
      accessibilityHint={task.kind === 'INSPECTION' ? 'Opens the areas to inspect' : 'Opens the filters to photograph'}
      // Status is a colour and a glyph otherwise, neither of which a screen reader can see.
      accessibilityLabel={[titleOf(task), STATE_WORD[task.state], task.detail].filter(Boolean).join(', ')}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      className={`min-h-14 flex-row items-center gap-3 rounded-xl border bg-card px-3 py-3 ${tone.ring} ${
        disabled ? 'opacity-50' : PRESS_ROW
      }`}
      disabled={disabled}
      onPress={onOpen}
    >
      <View importantForAccessibility="no-hide-descendants" className="h-6 w-6 items-center justify-center">
        <StateGlyph state={task.state} />
      </View>
      <View importantForAccessibility="no-hide-descendants" className="min-w-0 flex-1">
        <Text className="text-base font-semibold text-foreground">{titleOf(task)}</Text>
        <Text className={`mt-0.5 text-xs ${tone.text}`}>{task.detail ?? STATE_WORD[task.state]}</Text>
      </View>
      <ChevronRightIcon importantForAccessibility="no-hide-descendants" size={16} className="text-muted-foreground" />
    </Pressable>
  );
}

/**
 * What the list can do, by where the job is.
 *
 * - `preview` before Start job: what is booked, nothing to tick yet.
 * - `working` once started: tick and open.
 * - `done` once submitted: the inspection still opens, to look back at its
 *   areas (that screen is read-only then); nothing can be ticked or re-answered.
 */
export type JobTasksMode = 'preview' | 'working' | 'done';

const SUBTITLE: Record<JobTasksMode, string> = {
  preview: 'Start the job to work through these.',
  working: 'Tick what you did, and open the rest. Anything unticked goes to the office as not done.',
  done: 'How the job went.',
};

export function JobTasksCard({
  tasks,
  onOpen,
  onToggle,
  onNotDone,
  mode,
  className = '',
}: {
  tasks: JobTask[];
  /** The filter change or the inspection was tapped. */
  onOpen: (task: JobTask) => void;
  /** A service's checkbox was tapped. */
  onToggle: (task: JobTask) => void;
  /** A service's "Not done" was tapped. */
  onNotDone: (task: JobTask) => void;
  mode: JobTasksMode;
  className?: string;
}) {
  if (!tasks.length) return null;
  const working = mode === 'working';

  return (
    <Card className={`gap-3 ${className}`}>
      <View className="gap-1">
        <Text className="text-base font-semibold text-foreground">This job</Text>
        <Text className="text-sm text-muted-foreground">{SUBTITLE[mode]}</Text>
      </View>

      <View className="gap-2">
        {tasks.map((task) =>
          task.kind === 'SERVICE' ? (
            <CheckboxRow
              disabled={!working}
              key={task.key}
              onNotDone={() => onNotDone(task)}
              onToggle={() => onToggle(task)}
              task={task}
            />
          ) : (
            <OpenRow
              disabled={!(working || (mode === 'done' && task.kind === 'INSPECTION'))}
              key={task.key}
              onOpen={() => onOpen(task)}
              task={task}
            />
          ),
        )}
      </View>
    </Card>
  );
}
