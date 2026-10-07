import { useEffect, useMemo, useState } from 'react';
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react-native';
import { Pressable, Text, View } from 'react-native';

import type { InspectionStatus } from '../domain/models';
import { useJobDays } from '../features/queries';
import { registerIcons } from '../lib/icons';
import {
  addDays,
  addMonths,
  daySpoken,
  monthGrid,
  monthOf,
  monthTitle,
  type JobDay,
  type JobMonth,
} from '../utils/job-day';
import { BottomSheet } from './BottomSheet';
import { Button } from './ui';

registerIcons(ChevronLeftIcon, ChevronRightIcon);

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const;

/**
 * A month to pick a day from, for days past the end of the strip.
 *
 * The same dots as the strip, for the month on show: solid for work still to
 * do, faint for a day that is all done. `latest` closes the months after it --
 * History has nothing in the future to show.
 */
export function MonthCalendarSheet({
  visible,
  selected,
  today,
  statuses,
  latest,
  onSelect,
  onClose,
}: {
  visible: boolean;
  selected: JobDay | null;
  today: JobDay;
  statuses?: readonly InspectionStatus[];
  latest?: JobDay;
  onSelect: (day: JobDay) => void;
  onClose: () => void;
}) {
  const [month, setMonth] = useState<JobMonth>(monthOf(selected ?? today));
  // Opens on the chosen day's month every time, not wherever it was left.
  useEffect(() => {
    if (visible) setMonth(monthOf(selected ?? today));
  }, [visible, selected, today]);

  const grid = useMemo(() => monthGrid(month), [month]);
  const from = `${month}-01`;
  const to = addDays(`${addMonths(month, 1)}-01`, -1);
  const days = useJobDays({ from, to, statuses });
  const counts = useMemo(
    () => new Map((days.data ?? []).map((count) => [count.day, count])),
    [days.data],
  );
  const canGoForward = !latest || `${addMonths(month, 1)}-01` <= latest;

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <View className="flex-row items-center justify-between pb-3">
        <Pressable
          accessibilityLabel="Previous month"
          accessibilityRole="button"
          className="h-11 w-11 items-center justify-center rounded-xl active:opacity-60"
          onPress={() => setMonth((current) => addMonths(current, -1))}
        >
          <ChevronLeftIcon size={22} className="text-foreground" />
        </Pressable>
        <Text accessibilityRole="header" className="text-lg font-semibold text-foreground">
          {monthTitle(month)}
        </Text>
        <Pressable
          accessibilityLabel="Next month"
          accessibilityRole="button"
          accessibilityState={{ disabled: !canGoForward }}
          className={`h-11 w-11 items-center justify-center rounded-xl active:opacity-60 ${canGoForward ? '' : 'opacity-30'}`}
          disabled={!canGoForward}
          onPress={() => setMonth((current) => addMonths(current, 1))}
        >
          <ChevronRightIcon size={22} className="text-foreground" />
        </Pressable>
      </View>

      <View className="flex-row" importantForAccessibility="no-hide-descendants">
        {WEEKDAYS.map((weekday, index) => (
          <Text className="flex-1 text-center text-xs font-medium text-muted-foreground" key={index}>
            {weekday}
          </Text>
        ))}
      </View>

      <View className="mt-2 gap-1">
        {grid.map((week, row) => (
          <View className="flex-row" key={row}>
            {week.map((day, column) => {
              if (!day) return <View className="h-12 flex-1" key={column} />;
              const count = counts.get(day);
              const isSelected = day === selected;
              const isToday = day === today;
              const disabled = Boolean(latest && day > latest);
              return (
                <Pressable
                  accessibilityLabel={`${isToday ? 'Today, ' : ''}${daySpoken(day)}${
                    count?.total ? `, ${count.total} job${count.total === 1 ? '' : 's'}` : ''
                  }`}
                  accessibilityRole="button"
                  accessibilityState={{ selected: isSelected, disabled }}
                  className="h-12 flex-1 items-center justify-center active:opacity-60"
                  disabled={disabled}
                  key={day}
                  onPress={() => onSelect(day)}
                >
                  <View
                    className={`h-9 w-9 items-center justify-center rounded-full ${
                      isSelected ? 'bg-primary' : isToday ? 'border border-primary' : ''
                    }`}
                  >
                    <Text
                      className={`text-base ${
                        isSelected
                          ? 'font-semibold text-primary-foreground'
                          : disabled
                            ? 'text-muted-foreground/40'
                            : isToday
                              ? 'font-semibold text-primary'
                              : 'text-foreground'
                      }`}
                    >
                      {Number(day.slice(8, 10))}
                    </Text>
                  </View>
                  <View
                    className={`mt-0.5 h-1 w-1 rounded-full ${
                      !count?.total ? '' : count.open > 0 ? 'bg-primary' : 'bg-muted-foreground/40'
                    }`}
                  />
                </Pressable>
              );
            })}
          </View>
        ))}
      </View>

      <View className="mt-4">
        <Button
          label="Today"
          variant="secondary"
          onPress={() => {
            setMonth(monthOf(today));
            onSelect(today);
          }}
        />
      </View>
    </BottomSheet>
  );
}
