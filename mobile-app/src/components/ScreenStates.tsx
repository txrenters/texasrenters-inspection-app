import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';

import { AppButton } from './ui';
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

  useEffect(() => {
    const rotationLoop = Animated.loop(
      Animated.timing(rotation, {
        toValue: 1,
        duration: 1_400,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    const pulseLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 700,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 700,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );

    rotationLoop.start();
    pulseLoop.start();
    return () => {
      rotationLoop.stop();
      pulseLoop.stop();
    };
  }, [pulse, rotation]);

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
          <View style={styles.skeleton} />
          <View style={[styles.skeleton, styles.shortSkeleton]} />
        </Animated.View>
      </View>
    </View>
  );
}

export function EmptyState({ title, message }: { title: string; message: string }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.center}>
      <View style={styles.emptyIcon}>
        <Text style={styles.emptyIconText}>○</Text>
      </View>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.message}>{message}</Text>
    </View>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.center}>
      <View style={[styles.emptyIcon, styles.errorIcon]}>
        <Text style={styles.errorIconText}>!</Text>
      </View>
      <Text style={styles.error}>Couldn’t load this screen</Text>
      <Text style={styles.message}>{friendlyMessage(message)}</Text>
      <AppButton label="Try again" onPress={onRetry} compact />
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
    center: { padding: spacing.xl, alignItems: 'center', gap: spacing.md },
    loadingRoot: {
      flex: 1,
      width: '100%',
      minHeight: '100%',
      alignItems: 'center',
      justifyContent: 'center',
      padding: spacing.xl,
      backgroundColor: colors.canvas,
    },
    loadingCard: {
      width: '100%',
      maxWidth: 360,
      alignItems: 'center',
      gap: spacing.lg,
      paddingHorizontal: spacing.xl,
      paddingVertical: 32,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.xl,
      backgroundColor: colors.surface,
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
    error: { ...typography.heading, color: colors.danger, textAlign: 'center' },
    message: { ...typography.body, color: colors.textSecondary, textAlign: 'center' },
    skeleton: {
      height: 14,
      width: '100%',
      borderRadius: radius.round,
      backgroundColor: colors.surfaceMuted,
    },
    skeletonGroup: { width: '100%', alignItems: 'center', gap: spacing.sm },
    shortSkeleton: { width: '64%' },
    emptyIcon: {
      width: 52,
      height: 52,
      borderRadius: 26,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surfaceMuted,
    },
    emptyIconText: { color: colors.primary, fontSize: 30 },
    errorIcon: { backgroundColor: colors.dangerSoft },
    errorIconText: { color: colors.danger, fontSize: 24, fontWeight: '900' },
  });
