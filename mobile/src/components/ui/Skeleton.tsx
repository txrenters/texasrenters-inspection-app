import { useEffect, useRef } from 'react';
import { Animated, Easing, View, type ViewStyle } from 'react-native';

import { useReducedMotion } from '../../lib/reduced-motion';

type SkeletonProps = {
  /** Tailwind classes for shape and spacing — height and width belong here. */
  className?: string;
  style?: ViewStyle;
};

/**
 * One pulsing placeholder block.
 *
 * Screens used to render the word "Loading…" over an empty background, which
 * gives no sense of what is about to appear and makes every screen look
 * identical while it waits. A skeleton in the shape of the real content lets
 * the technician start reading the layout before the data lands.
 */
export function Skeleton({ className = '', style }: SkeletonProps) {
  const pulse = usePulse();
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[{ opacity: pulse }, style]}
      className={`rounded-lg bg-muted ${className}`}
    />
  );
}

/**
 * Shared opacity loop.
 *
 * One `Animated.Value` per skeleton block means a screen with a dozen of them
 * runs a dozen timers; they all start on their own mount, so the blocks drift
 * out of phase and the screen shimmers unevenly. Each block still owns its
 * value here, but the identical timing keeps them close enough to read as one
 * surface.
 */
function usePulse() {
  const value = useRef(new Animated.Value(0.4)).current;
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    // A screen full of blocks breathing in unison is exactly the kind of
    // ambient motion the setting exists to stop. Held at a readable opacity
    // instead, so the layout still reads as placeholder content.
    if (reducedMotion) {
      value.setValue(0.6);
      return;
    }
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(value, {
          toValue: 0.85,
          duration: 700,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(value, {
          toValue: 0.4,
          duration: 700,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [reducedMotion, value]);

  return value;
}

/**
 * Marks a whole skeleton screen for assistive tech.
 *
 * Without this a screen reader walks a dozen unlabelled empty boxes. One
 * "busy" region announces the wait once and hides the rest.
 */
export function SkeletonScreen({
  children,
  label = 'Loading content',
}: {
  children: React.ReactNode;
  label?: string;
}) {
  return (
    <View accessibilityRole="progressbar" accessibilityLabel={label} accessible={false}>
      {children}
    </View>
  );
}

/** Placeholder for one assignment or inspection row. */
export function InspectionCardSkeleton() {
  return (
    <View className="mx-5 mt-3 rounded-2xl border border-border bg-card p-4">
      <View className="flex-row items-center justify-between">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-5 w-20 rounded-full" />
      </View>
      <Skeleton className="mt-3 h-5 w-3/4" />
      <Skeleton className="mt-2 h-3 w-1/2" />
      <View className="mt-4 flex-row gap-2">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-3 w-16" />
      </View>
    </View>
  );
}

/** Placeholder list used by the dashboard and the inspections tab. */
export function InspectionListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <SkeletonScreen label="Loading inspections">
      {Array.from({ length: rows }, (_, index) => (
        <InspectionCardSkeleton key={index} />
      ))}
    </SkeletonScreen>
  );
}

/** Placeholder for the dashboard's summary tiles. */
export function StatsRowSkeleton() {
  return (
    <SkeletonScreen label="Loading summary">
      <View className="mx-5 mt-5 flex-row gap-3">
        {Array.from({ length: 3 }, (_, index) => (
          <View key={index} className="flex-1 rounded-2xl border border-border bg-card p-4">
            <Skeleton className="h-7 w-10" />
            <Skeleton className="mt-2 h-3 w-full" />
          </View>
        ))}
      </View>
    </SkeletonScreen>
  );
}

/** Placeholder for a detail screen: header block then a stack of sections. */
export function DetailSkeleton({ sections = 3 }: { sections?: number }) {
  return (
    <SkeletonScreen label="Loading details">
      <View className="px-5 pt-4">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="mt-3 h-7 w-2/3" />
        <Skeleton className="mt-2 h-4 w-1/2" />
      </View>
      {Array.from({ length: sections }, (_, index) => (
        <View key={index} className="mx-5 mt-4 rounded-2xl border border-border bg-card p-4">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="mt-3 h-3 w-full" />
          <Skeleton className="mt-2 h-3 w-5/6" />
        </View>
      ))}
    </SkeletonScreen>
  );
}

/** Placeholder for the uploads queue. */
export function UploadListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <SkeletonScreen label="Loading upload queue">
      {Array.from({ length: rows }, (_, index) => (
        <View key={index} className="mx-5 mt-3 rounded-2xl border border-border bg-card p-4">
          <View className="flex-row items-center gap-3">
            <Skeleton className="h-10 w-10 rounded-xl" />
            <View className="flex-1 gap-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/3" />
            </View>
          </View>
          <Skeleton className="mt-3 h-2 w-full rounded-full" />
        </View>
      ))}
    </SkeletonScreen>
  );
}

/** Placeholder grid for room photos and captured media. */
export function MediaGridSkeleton({ tiles = 4 }: { tiles?: number }) {
  return (
    <SkeletonScreen label="Loading media">
      <View className="flex-row flex-wrap gap-2">
        {Array.from({ length: tiles }, (_, index) => (
          <Skeleton key={index} className="h-24 w-24 rounded-xl" />
        ))}
      </View>
    </SkeletonScreen>
  );
}
