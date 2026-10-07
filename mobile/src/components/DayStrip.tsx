import { memo, useEffect, useRef } from 'react';
import * as Haptics from 'expo-haptics';
import { FlatList, Platform, Pressable, Text, View } from 'react-native';

import type { JobDayCount } from '../repositories/contracts';
import { dayCell, daySpoken, type JobDay } from '../utils/job-day';

const CELL_WIDTH = 48;
const CELL_GAP = 6;
const STEP = CELL_WIDTH + CELL_GAP;
const SIDE_PADDING = 20;

/**
 * A row of days to pick from, a dot under each one that holds jobs.
 *
 * A solid dot is work still to do; a faint one, a day that is all done. The
 * chosen day is filled, and today is marked in the accent colour whether or
 * not it is chosen -- so it can always be found again at a glance. Scrolled to
 * keep the chosen day in view, whichever way it was chosen.
 */
export const DayStrip = memo(function DayStrip({
  days,
  selected,
  today,
  counts,
  onSelect,
}: {
  days: readonly JobDay[];
  selected: JobDay | null;
  today: JobDay;
  counts: ReadonlyMap<JobDay, JobDayCount>;
  onSelect: (day: JobDay) => void;
}) {
  const list = useRef<FlatList<JobDay>>(null);
  const selectedIndex = selected ? days.indexOf(selected) : -1;
  const openingIndex = useRef(Math.max(0, selectedIndex >= 0 ? selectedIndex : days.indexOf(today)));
  const placed = useRef(false);

  // Afterwards the strip follows the chosen day, centred. The first placement
  // is `onLayout`'s, below: it needs the strip's width, and an animated scroll
  // on opening would sweep past every day before it.
  useEffect(() => {
    if (!placed.current || selectedIndex < 0) return;
    list.current?.scrollToIndex({ index: selectedIndex, viewPosition: 0.5, animated: true });
  }, [selectedIndex]);

  return (
    <FlatList
      ref={list}
      horizontal
      data={days}
      keyExtractor={(day) => day}
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ paddingHorizontal: SIDE_PADDING, gap: CELL_GAP }}
      getItemLayout={(_, index) => ({ length: CELL_WIDTH, offset: SIDE_PADDING + index * STEP, index })}
      // Opens with the chosen day in the middle, the days before it in view --
      // not pinned to the left edge with yesterday out of sight.
      onLayout={(event) => {
        if (placed.current) return;
        placed.current = true;
        const width = event.nativeEvent.layout.width;
        const offset = SIDE_PADDING + openingIndex.current * STEP - (width - CELL_WIDTH) / 2;
        list.current?.scrollToOffset({ offset: Math.max(0, offset), animated: false });
      }}
      // A strip of a few dozen fixed cells: drawing them all at once is cheaper
      // than measuring which ones are on screen.
      initialNumToRender={days.length}
      onScrollToIndexFailed={() => undefined}
      renderItem={({ item: day }) => (
        <DayCell
          day={day}
          count={counts.get(day)}
          isSelected={day === selected}
          isToday={day === today}
          onSelect={onSelect}
        />
      )}
    />
  );
});

const DayCell = memo(function DayCell({
  day,
  count,
  isSelected,
  isToday,
  onSelect,
}: {
  day: JobDay;
  count: JobDayCount | undefined;
  isSelected: boolean;
  isToday: boolean;
  onSelect: (day: JobDay) => void;
}) {
  const { weekday, date } = dayCell(day);
  const jobs = count?.total ?? 0;
  const dot = !jobs
    ? null
    : isSelected
      ? count!.open > 0
        ? 'bg-primary-foreground'
        : 'bg-primary-foreground/50'
      : count!.open > 0
        ? 'bg-primary'
        : 'bg-muted-foreground/40';
  return (
    <Pressable
      accessibilityLabel={[
        isToday ? 'Today' : '',
        daySpoken(day),
        jobs ? `${jobs} job${jobs === 1 ? '' : 's'}${count!.open ? `, ${count!.open} to do` : ', all done'}` : 'no jobs',
      ]
        .filter(Boolean)
        .join(', ')}
      accessibilityRole="button"
      accessibilityState={{ selected: isSelected }}
      className={`h-16 items-center justify-center rounded-xl ${isSelected ? 'bg-primary' : 'bg-card'} active:opacity-60`}
      style={{ width: CELL_WIDTH }}
      onPress={() => {
        if (Platform.OS === 'ios') void Haptics.selectionAsync().catch(() => undefined);
        onSelect(day);
      }}
    >
      <Text
        className={`text-[11px] font-medium ${
          isSelected ? 'text-primary-foreground' : isToday ? 'text-primary' : 'text-muted-foreground'
        }`}
      >
        {weekday}
      </Text>
      <Text
        className={`mt-0.5 text-base font-semibold ${
          isSelected ? 'text-primary-foreground' : isToday ? 'text-primary' : 'text-foreground'
        }`}
      >
        {date}
      </Text>
      <View className={`mt-1 h-1.5 w-1.5 rounded-full ${dot ?? ''}`} />
    </Pressable>
  );
});
