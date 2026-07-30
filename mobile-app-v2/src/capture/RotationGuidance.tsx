import { memo } from 'react';
import { CheckIcon, RotateCwIcon, TriangleAlertIcon } from 'lucide-react-native';
import { Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import { registerIcons } from '../lib/icons';
import { SPACING, type CameraLayout } from './camera-layout';
import type { Guidance } from './guidance-state';

registerIcons(CheckIcon, RotateCwIcon, TriangleAlertIcon);

const RING = 34;
const CIRCUMFERENCE = 2 * Math.PI * RING;

const TONE_TEXT = {
  neutral: 'text-white',
  active: 'text-white',
  warning: 'text-amber-300',
  success: 'text-emerald-300',
} as const;

const TONE_STROKE = {
  neutral: '#FFFFFF',
  active: '#5EEAD4',
  warning: '#FCD34D',
  success: '#6EE7B7',
} as const;

/**
 * The live guidance layer: one step, one instruction, one arrow.
 *
 * Positioned against the measured guide rather than the screen, so it sits
 * inside the framing region and never drifts under the controls. Memoised
 * because the sensor updates several times a second and the camera preview
 * must not be re-rendered with it.
 */
export const RotationGuidance = memo(function RotationGuidance({
  guidance,
  layout,
  reduceMotion,
  showProgress,
}: {
  guidance: Guidance;
  layout: CameraLayout;
  /** When true, the arrow holds still instead of sweeping. */
  reduceMotion: boolean;
  /** False for additional evidence, which has no 360° requirement. */
  showProgress: boolean;
}) {
  const percent = Math.round(guidance.progress * 100);
  const stroke = TONE_STROKE[guidance.tone];

  return (
    <View
      // One accessibility node, announced politely: a screen reader user gets
      // the state change without the arrow, which they cannot see anyway.
      accessible
      accessibilityLabel={`${guidance.headline}. ${guidance.instruction}${
        showProgress ? ` ${percent} percent of the turn captured.` : ''
      }`}
      accessibilityLiveRegion="polite"
      pointerEvents="none"
      style={{
        position: 'absolute',
        top: layout.guidanceTop,
        left: layout.guide.left,
        width: layout.guide.width,
        alignItems: 'center',
        gap: SPACING.sm,
      }}
    >
      {showProgress ? (
        <View className="h-[84px] w-[84px] items-center justify-center">
          <Svg width={84} height={84} style={{ position: 'absolute' }}>
            <Circle
              cx={42}
              cy={42}
              r={RING}
              fill="rgba(0,0,0,0.45)"
              stroke="rgba(255,255,255,0.22)"
              strokeWidth={6}
            />
            <Circle
              cx={42}
              cy={42}
              r={RING}
              fill="transparent"
              stroke={stroke}
              strokeDasharray={`${CIRCUMFERENCE} ${CIRCUMFERENCE}`}
              strokeDashoffset={CIRCUMFERENCE * (1 - guidance.progress)}
              strokeLinecap="round"
              strokeWidth={6}
              // Clockwise from the top, matching the direction being asked for.
              rotation="-90"
              origin="42,42"
            />
          </Svg>
          {guidance.arrow === 'COMPLETE' ? (
            <CheckIcon size={26} className="text-emerald-300" />
          ) : guidance.arrow === 'WARNING' ? (
            <TriangleAlertIcon size={24} className="text-amber-300" />
          ) : (
            <RotateCwIcon
              size={24}
              className={TONE_TEXT[guidance.tone]}
              // Reduced motion keeps the arrow upright rather than sweeping.
              style={reduceMotion ? undefined : { transform: [{ rotate: '0deg' }] }}
            />
          )}
          <Text className="absolute bottom-1 text-[10px] font-black text-white">
            {percent}%
          </Text>
        </View>
      ) : null}

      <View
        className={`max-w-full items-center rounded-2xl px-4 py-2 ${
          guidance.tone === 'warning' ? 'bg-amber-950/85' : 'bg-black/70'
        }`}
      >
        <Text className={`text-sm font-bold ${TONE_TEXT[guidance.tone]}`} numberOfLines={1}>
          {guidance.headline}
        </Text>
        <Text className="text-center text-xs leading-4 text-white/75" numberOfLines={2}>
          {guidance.instruction}
        </Text>
      </View>
    </View>
  );
});
