import { CheckCircle2Icon, CircleIcon, TriangleAlertIcon } from 'lucide-react-native';
import { Text, View } from 'react-native';

import { registerIcons } from '../lib/icons';
import { SPACING } from './camera-layout';
import type { CaptureCoverageStatus, GuidedCaptureSummary } from './guided-capture';

registerIcons(CheckCircle2Icon, CircleIcon, TriangleAlertIcon);

/**
 * How the guidance result is described to the technician.
 *
 * Every phrasing is about the *walkthrough*, never the area. Rotation guidance
 * completing does not mean the evidence is sufficient or the area is done —
 * those are separate decisions made later, by the checklist and by the office.
 */
const ASSESSMENT: Record<CaptureCoverageStatus, { headline: string; detail: string; tone: 'ok' | 'warn' }> = {
  COMPLETE: {
    headline: 'Guided walkthrough likely complete',
    detail: 'A full clockwise turn was measured and you returned to the start.',
    tone: 'ok',
  },
  LIKELY_COMPLETE: {
    headline: 'Guided walkthrough likely complete',
    detail: 'The turn looks complete, though the motion signal was less steady.',
    tone: 'ok',
  },
  INCOMPLETE: {
    headline: 'Additional review recommended',
    detail: 'Less than a full turn was measured. The recording is still saved.',
    tone: 'warn',
  },
  LOW_CONFIDENCE: {
    headline: 'Additional review recommended',
    detail: 'Motion readings were noisy, so the turn could not be measured reliably.',
    tone: 'warn',
  },
  SENSOR_UNAVAILABLE: {
    headline: 'Motion guidance unavailable',
    detail: 'Rotation was not measured on this device. Your recording is unaffected.',
    tone: 'warn',
  },
  MANUALLY_CONFIRMED: {
    headline: 'Confirmed by you',
    detail: 'You confirmed the walkthrough manually rather than by motion.',
    tone: 'ok',
  },
};

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row items-center justify-between py-1.5">
      <Text className="text-sm text-muted-foreground">{label}</Text>
      <Text className="text-sm font-semibold text-foreground">{value}</Text>
    </View>
  );
}

export function CaptureSummaryCard({ summary }: { summary: GuidedCaptureSummary }) {
  const assessment = ASSESSMENT[summary.coverageStatus];
  const warn = assessment.tone === 'warn';

  return (
    <View className="mt-5 rounded-2xl bg-card p-5" style={{ gap: SPACING.md }}>
      <View className="flex-row items-start" style={{ gap: SPACING.sm }}>
        {warn ? (
          <TriangleAlertIcon size={18} className="mt-0.5 text-chart-4" />
        ) : (
          <CheckCircle2Icon size={18} className="mt-0.5 text-chart-3" />
        )}
        <View className="min-w-0 flex-1">
          <Text className={`text-base font-semibold ${warn ? 'text-chart-4' : 'text-foreground'}`}>
            {assessment.headline}
          </Text>
          <Text className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {assessment.detail}
          </Text>
        </View>
      </View>

      <View className="border-t border-border pt-1">
        <Row label="Duration" value={`${summary.durationSeconds}s`} />
        {summary.sensorSupported ? (
          <>
            <Row label="Clockwise rotation" value={`${summary.clockwiseRotationDegrees}°`} />
            {summary.counterClockwiseRotationDegrees > 0 ? (
              <Row
                label="Counter-clockwise"
                value={`${summary.counterClockwiseRotationDegrees}°`}
              />
            ) : null}
            <Row label="Returned to start" value={summary.returnedToStart ? 'Yes' : 'No'} />
            <Row label="Motion confidence" value={summary.sensorConfidence.toLowerCase()} />
          </>
        ) : null}
        <Row label="Snapshots" value={String(summary.snapshotCount)} />
        <Row label="Findings marked" value={String(summary.findingMarkerCount)} />
      </View>

      {/* Stated outright, because "walkthrough complete" is exactly the phrase a
          technician is most likely to read as "this area is finished". */}
      <Text className="text-xs leading-5 text-muted-foreground">
        This describes the walkthrough only. The area is not complete until its evidence
        requirements are met and the office has reviewed it.
      </Text>
    </View>
  );
}
