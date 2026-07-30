import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import { GUIDED_CAPTURE_POLICY, rotationProgress, type RotationTracker } from './guided-capture';

export function GuidedCaptureOverlay({
  tracker,
  sensorAvailable,
  returnedToStart,
}: {
  tracker: RotationTracker;
  sensorAvailable: boolean;
  returnedToStart: boolean;
}) {
  const progress = rotationProgress(tracker);
  const circumference = 2 * Math.PI * 42;
  const wrongDirection =
    tracker.counterClockwiseRotationDegrees >= GUIDED_CAPTURE_POLICY.wrongDirectionWarningDegrees;
  const instruction =
    progress >= 0.92
      ? returnedToStart
        ? 'Rotation estimate complete. Capture any missing evidence.'
        : 'Continue slowly to the Wall 1 start marker.'
      : wrongDirection
        ? 'Turn the other way — continue clockwise.'
        : 'Rotate slowly clockwise. Keep walls centered.';

  return (
    <View style={styles.container}>
      <View style={styles.progress}>
        <Svg width={104} height={104} style={StyleSheet.absoluteFill}>
          <Circle
            cx={52}
            cy={52}
            r={42}
            fill="rgba(5,16,15,0.56)"
            stroke="rgba(255,255,255,0.3)"
            strokeWidth={7}
          />
          <Circle
            cx={52}
            cy={52}
            r={42}
            fill="transparent"
            stroke="#86D239"
            strokeDasharray={`${circumference} ${circumference}`}
            strokeDashoffset={circumference * (1 - progress)}
            strokeLinecap="round"
            strokeWidth={7}
            rotation="-90"
            origin="52,52"
          />
        </Svg>
        <Ionicons color="#FFFFFF" name="arrow-forward-circle" size={28} />
        <Text style={styles.percent}>
          {sensorAvailable ? `${Math.round(progress * 100)}%` : 'GUIDE'}
        </Text>
      </View>
      <View style={[styles.instruction, wrongDirection && styles.warning]}>
        <Text style={styles.instructionText}>{instruction}</Text>
        <Text style={styles.disclaimer}>
          Motion is an estimate; photos and your confirmation verify evidence.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    pointerEvents: 'none',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 12,
    paddingBottom: 16,
  },
  progress: {
    width: 104,
    height: 104,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 1,
  },
  percent: { color: '#FFFFFF', fontSize: 12, fontWeight: '900' },
  instruction: {
    maxWidth: '90%',
    borderRadius: 14,
    backgroundColor: 'rgba(5,16,15,0.74)',
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  warning: { backgroundColor: 'rgba(124,65,8,0.88)' },
  instructionText: { color: '#FFFFFF', fontSize: 13, fontWeight: '800', textAlign: 'center' },
  disclaimer: { color: '#C8D7D5', fontSize: 10, marginTop: 3, textAlign: 'center' },
});
