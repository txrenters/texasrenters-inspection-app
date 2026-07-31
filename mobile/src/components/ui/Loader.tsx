import { useEffect, useRef } from 'react';
import { Animated, Easing, Text, View } from 'react-native';
import { useColorScheme } from 'nativewind';
import Svg, { Circle } from 'react-native-svg';

import { useReducedMotion } from '../../lib/reduced-motion';

const AnimatedSvg = Animated.createAnimatedComponent(Svg);

const SIZES = { sm: 18, md: 28, lg: 40 } as const;
const STROKE = { sm: 2, md: 2.5, lg: 3 } as const;

export type LoaderSize = keyof typeof SIZES;

type LoaderProps = {
  size?: LoaderSize;
  /** Announced to screen readers; also rendered when `label` is passed to the block variants. */
  accessibilityLabel?: string;
};

/**
 * The app's spinner.
 *
 * Replaces the platform `ActivityIndicator`, which rendered as a grey iOS
 * pinwheel or a blue Android ring depending on the device — neither of which is
 * a TexasRenters colour, and neither matching the other. This is one mark in the
 * brand teal on both platforms.
 */
export function Loader({ size = 'md', accessibilityLabel = 'Loading' }: LoaderProps) {
  const { colorScheme } = useColorScheme();
  const reducedMotion = useReducedMotion();
  const tint = colorScheme === 'dark' ? '#2dd4bf' : '#145347';
  const spin = useRef(new Animated.Value(0)).current;
  const diameter = SIZES[size];
  const stroke = STROKE[size];
  const radius = (diameter - stroke) / 2;
  const circumference = 2 * Math.PI * radius;

  useEffect(() => {
    // Nothing turns when the OS asks for reduced motion. The ring below still
    // draws, and the accessible label still says "Loading" — the state is
    // conveyed without anything moving.
    if (reducedMotion) {
      spin.setValue(0);
      return;
    }
    const animation = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 900,
        easing: Easing.linear,
        // Runs on the UI thread, so the ring keeps turning while JS is busy
        // parsing the very response the technician is waiting for.
        useNativeDriver: true,
      }),
    );
    animation.start();
    return () => animation.stop();
  }, [reducedMotion, spin]);

  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  return (
    <AnimatedSvg
      width={diameter}
      height={diameter}
      style={{ transform: [{ rotate }] }}
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
    >
      {/* Full ring at low opacity, so the gap reads as a moving highlight
          rather than a piece of the circle being missing. */}
      <Circle
        cx={diameter / 2}
        cy={diameter / 2}
        r={radius}
        stroke={tint}
        strokeWidth={stroke}
        strokeOpacity={0.2}
        fill="none"
      />
      <Circle
        cx={diameter / 2}
        cy={diameter / 2}
        r={radius}
        stroke={tint}
        strokeWidth={stroke}
        strokeLinecap="round"
        fill="none"
        strokeDasharray={`${circumference * (reducedMotion ? 0.75 : 0.28)} ${circumference}`}
      />
    </AnimatedSvg>
  );
}

type LoaderBlockProps = {
  label?: string;
  size?: LoaderSize;
};

/** Centred loader for a whole screen, matching the app background. */
export function ScreenLoader({ label = 'Loading…', size = 'lg' }: LoaderBlockProps) {
  return (
    <View className="flex-1 items-center justify-center gap-3 bg-background">
      <Loader size={size} accessibilityLabel={label} />
      <LoaderLabel label={label} />
    </View>
  );
}

/** Centred loader sized to sit inside a card or list section. */
export function InlineLoader({ label, size = 'md' }: LoaderBlockProps) {
  return (
    <View className="items-center justify-center gap-2 py-6">
      <Loader size={size} accessibilityLabel={label ?? 'Loading'} />
      {label ? <LoaderLabel label={label} /> : null}
    </View>
  );
}

function LoaderLabel({ label }: { label: string }) {
  return (
    // Not announced: the spinner already carries the accessible label, and a
    // second identical string makes VoiceOver read "Loading, Loading".
    <Text
      accessibilityElementsHidden
      importantForAccessibility="no"
      className="text-sm text-muted-foreground"
    >
      {label}
    </Text>
  );
}
