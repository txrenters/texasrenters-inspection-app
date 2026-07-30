import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import {
  rotationProgress,
  type GuidedCaptureState,
  type RotationTracker,
} from './guided-capture';

const GUIDANCE_COPY: Record<GuidedCaptureState, { label: string; detail: string }> = {
  READY: {
    label: 'Face Wall 1',
    detail: 'Start here, then make one slow clockwise walkthrough.',
  },
  RECORDING: {
    label: 'Wall 1 registered',
    detail: 'Begin turning slowly clockwise.',
  },
  ROTATE_CLOCKWISE: {
    label: 'Rotate clockwise',
    detail: 'Keep the walls centered and narrate visible conditions.',
  },
  WRONG_DIRECTION: {
    label: 'Turn the other way',
    detail: 'Continue clockwise; small corrections are okay.',
  },
  TOO_FAST: {
    label: 'Slow down',
    detail: 'Move steadily so the room remains clear.',
  },
  CONTINUE_AROUND_ROOM: {
    label: 'Continue clockwise',
    detail: 'Keep moving around the room toward Wall 1.',
  },
  RETURN_TO_START: {
    label: 'Return to Wall 1',
    detail: 'Complete the loop at your starting wall.',
  },
  LIKELY_COMPLETE: {
    label: 'Walkthrough likely complete',
    detail: 'Capture any missing photos, then stop and review.',
  },
  COMPLETE: {
    label: 'Walkthrough complete',
    detail: 'Capture any missing photos, then stop and review.',
  },
  SENSOR_UNAVAILABLE: {
    label: 'Manual motion guide',
    detail: 'Complete one slow clockwise walkthrough.',
  },
};

export function GuidedCaptureOverlay({
  tracker,
  state,
}: {
  tracker: RotationTracker;
  state: GuidedCaptureState;
}) {
  const progress = state === 'READY' ? 0 : rotationProgress(tracker);
  const circumference = 2 * Math.PI * 24;
  const copy = GUIDANCE_COPY[state];
  const warning = state === 'WRONG_DIRECTION' || state === 'TOO_FAST';
  const complete = state === 'COMPLETE' || state === 'LIKELY_COMPLETE';

  return (
    <View
      accessible
      accessibilityLabel={`${copy.label}. ${copy.detail}`}
      pointerEvents="none"
      style={styles.container}
    >
      <View style={[styles.copy, warning && styles.warning, complete && styles.complete]}>
        <Ionicons
          color="#FFFFFF"
          name={
            complete
              ? 'checkmark-circle'
              : state === 'WRONG_DIRECTION'
                ? 'return-up-back'
                : state === 'TOO_FAST'
                  ? 'speedometer-outline'
                  : 'refresh'
          }
          size={18}
        />
        <View style={styles.copyText}>
          <Text numberOfLines={1} style={styles.label}>
            {copy.label}
          </Text>
          <Text numberOfLines={2} style={styles.detail}>
            {copy.detail}
          </Text>
        </View>
      </View>

      <View style={styles.progress}>
        <Svg height={60} style={StyleSheet.absoluteFill} width={60}>
          <Circle
            cx={30}
            cy={30}
            fill="rgba(3, 8, 12, 0.62)"
            r={24}
            stroke="rgba(255,255,255,0.28)"
            strokeWidth={4}
          />
          <Circle
            cx={30}
            cy={30}
            fill="transparent"
            origin="30,30"
            r={24}
            rotation="-90"
            stroke={warning ? '#F6C564' : complete ? '#86D239' : '#FFFFFF'}
            strokeDasharray={`${circumference} ${circumference}`}
            strokeDashoffset={circumference * (1 - progress)}
            strokeLinecap="round"
            strokeWidth={4}
          />
        </Svg>
        <Ionicons color="#FFFFFF" name="refresh" size={17} />
        <Text style={styles.percent}>
          {state === 'SENSOR_UNAVAILABLE' ? 'GUIDE' : `${Math.round(progress * 100)}%`}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 8,
  },
  copy: {
    minHeight: 52,
    maxWidth: 238,
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.24)',
    borderRadius: 16,
    backgroundColor: 'rgba(3, 8, 12, 0.68)',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  warning: {
    borderColor: 'rgba(246,197,100,0.65)',
    backgroundColor: 'rgba(91,55,8,0.78)',
  },
  complete: {
    borderColor: 'rgba(134,210,57,0.65)',
    backgroundColor: 'rgba(21,70,30,0.76)',
  },
  copyText: { minWidth: 0, flex: 1 },
  label: { color: '#FFFFFF', fontSize: 12, fontWeight: '800' },
  detail: { marginTop: 1, color: 'rgba(255,255,255,0.72)', fontSize: 10, lineHeight: 13 },
  progress: {
    width: 60,
    height: 60,
    alignItems: 'center',
    justifyContent: 'center',
  },
  percent: { color: '#FFFFFF', fontSize: 8, fontWeight: '900' },
});
