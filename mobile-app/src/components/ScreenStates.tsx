import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Platform,
  StyleSheet,
  View,
} from 'react-native';
import { CircleAlert, Inbox } from 'lucide-react-native';

import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Skeleton } from './ui/skeleton';
import { Text } from './ui/text';
import {
  type AppColors,
  radius,
  spacing,
  typography,
  useThemedStyles,
} from '../theme';

export function LoadingState({ label = 'Loading inspection data…' }: { label?: string }) {
  const styles = useThemedStyles(createStyles);
  const rotation = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(0)).current;
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReducedMotion);
    const subscription = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      setReducedMotion,
    );
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (reducedMotion) {
      rotation.setValue(0);
      pulse.setValue(0.65);
      return;
    }

    const useNativeDriver = Platform.OS !== 'web';
    const rotationLoop = Animated.loop(
      Animated.timing(rotation, {
        toValue: 1,
        duration: 1_400,
        easing: Easing.linear,
        useNativeDriver,
      }),
    );
    const pulseLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 700,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 700,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver,
        }),
      ]),
    );

    rotationLoop.start();
    pulseLoop.start();
    return () => {
      rotationLoop.stop();
      pulseLoop.stop();
    };
  }, [pulse, reducedMotion, rotation]);

  const spin = rotation.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const coreScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] });
  const skeletonOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.42, 0.9] });

  return (
    <View
      accessible
      accessibilityLabel={label}
      accessibilityRole="progressbar"
      accessibilityState={{ busy: true }}
      style={styles.loadingRoot}
      testID="loading-state"
    >
      <View style={styles.loadingCard}>
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={styles.loaderStage}
        >
          <View style={styles.loaderHalo} />
          <Animated.View style={[styles.loaderOrbit, { transform: [{ rotate: spin }] }]}>
            <View style={styles.orbitDot} />
          </Animated.View>
          <Animated.View
            style={[
              styles.loaderCore,
              { opacity: skeletonOpacity, transform: [{ scale: coreScale }] },
            ]}
          >
            <Text style={styles.loaderMark}>{'\u2605'}</Text>
          </Animated.View>
        </View>

        <View style={styles.loadingCopy}>
          <Text style={styles.loadingEyebrow}>TEXASRENTERS</Text>
          <Text style={styles.title}>{label}</Text>
        </View>

        <Animated.View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[styles.skeletonGroup, { opacity: skeletonOpacity }]}
        >
          <Skeleton className="h-3.5 w-full rounded-full" />
          <Skeleton className="h-3.5 w-2/3 rounded-full" />
        </Animated.View>
      </View>
    </View>
  );
}

export function EmptyState({
  title,
  message,
  compact = false,
}: {
  title: string;
  message: string;
  compact?: boolean;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={[styles.center, compact && styles.centerCompact]}>
      <View style={[styles.emptyIcon, compact && styles.emptyIconCompact]}>
        <Icon as={Inbox} className="text-primary" size={24} />
      </View>
      <Text variant="h4" className="text-center">
        {title}
      </Text>
      <Text variant="muted" className="text-center leading-5">
        {message}
      </Text>
    </View>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.center}>
      <Alert icon={CircleAlert} variant="destructive" className="max-w-sm">
        <AlertTitle>Couldn’t load this screen</AlertTitle>
        <AlertDescription>{friendlyMessage(message)}</AlertDescription>
      </Alert>
      <Button accessibilityLabel="Try loading this screen again" onPress={onRetry}>
        <Text>Try again</Text>
      </Button>
    </View>
  );
}

function friendlyMessage(message: string) {
  return message.includes('Demo data')
    ? message
    : 'The information is temporarily unavailable. Your saved work is still safe.';
}

const createStyles = (colors: AppColors) =>
  StyleSheet.create({
    center: {
      width: '100%',
      maxWidth: 360,
      minWidth: 0,
      alignSelf: 'center',
      padding: spacing.lg,
      alignItems: 'center',
      gap: spacing.md,
    },
    centerCompact: { paddingVertical: spacing.md, gap: spacing.sm },
    loadingRoot: {
      flex: 1,
      width: '100%',
      minWidth: 0,
      minHeight: '100%',
      alignItems: 'center',
      justifyContent: 'center',
      padding: spacing.lg,
      backgroundColor: colors.canvas,
    },
    loadingCard: {
      width: '100%',
      maxWidth: 320,
      minWidth: 0,
      alignItems: 'center',
      gap: spacing.lg,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xl,
    },
    loaderStage: {
      width: 92,
      height: 92,
      alignItems: 'center',
      justifyContent: 'center',
    },
    loaderHalo: {
      position: 'absolute',
      width: 80,
      height: 80,
      borderRadius: 40,
      backgroundColor: colors.primarySoft,
    },
    loaderOrbit: {
      position: 'absolute',
      width: 72,
      height: 72,
      borderWidth: 2,
      borderColor: colors.primary,
      borderRadius: 36,
    },
    orbitDot: {
      position: 'absolute',
      top: -6,
      left: 29,
      width: 12,
      height: 12,
      borderRadius: 6,
      backgroundColor: colors.secondary,
    },
    loaderCore: {
      width: 48,
      height: 48,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 16,
      backgroundColor: colors.primary,
    },
    loaderMark: { color: colors.white, fontSize: 20, lineHeight: 24, fontWeight: '900' },
    loadingCopy: { alignItems: 'center', gap: spacing.xs },
    loadingEyebrow: {
      ...typography.caption,
      color: colors.secondaryDark,
      fontSize: 11,
      letterSpacing: 1.4,
      fontWeight: '900',
    },
    title: { ...typography.heading, color: colors.textPrimary, textAlign: 'center' },
    skeletonGroup: { width: '100%', alignItems: 'center', gap: spacing.sm },
    emptyIcon: {
      width: 52,
      height: 52,
      borderRadius: radius.round,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surfaceMuted,
    },
    emptyIconCompact: { width: 42, height: 42 },
  });
