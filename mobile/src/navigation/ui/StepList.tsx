import { Text, View } from 'react-native';

import type { NavManeuver } from '@texasrenters/shared';

import { ManeuverIcon } from './ManeuverIcon';
import { navDistance, navDuration, navMiles, useNavColors } from './nav-colors';

/**
 * Every turn to the stop — and then a few of the turns after it.
 *
 * ## Why the list does not stop at the destination
 *
 * Because the day does not. A technician checking the list is usually asking
 * one of two things: "what is coming up", or "where does this put me". The
 * second question is about the next stop, and a list that ends at this one
 * sends them back to the day screen to answer it. Three steps of the next leg,
 * behind the header that names it, answer it in place.
 *
 * They are drawn at a lower opacity because they are not instructions yet —
 * they belong to a leg that has not been started and will be re-planned from
 * wherever the technician actually ends up.
 *
 * ## Why this scrolls in its parent
 *
 * It renders a plain `View`. The HUD above it and the sheet it opens into both
 * want to control the scroll container, and a nested scroll view inside either
 * of them is the classic way to end up with a list that cannot be flung.
 */

export interface StepRow {
  maneuver: NavManeuver;
  /** The router's own sentence — always right, even when the enum is not. */
  instruction: string;
  /** The road being joined, when the router names one separately. */
  roadName: string | null;
  distanceMeters: number;
}

export interface ArrivalRow {
  /** 1-based, the stop this leg ends at. */
  position: number;
  total: number;
  /** "Move-out inspection", in the office's words. */
  inspectionType: string;
  /** Clock time of arrival — "12:12 PM". */
  etaLabel: string;
  /** Which side of the road the property is on, when the router says. */
  side: 'LEFT' | 'RIGHT' | null;
}

export interface NextLegRow {
  position: number;
  driveSeconds: number;
  driveMeters: number;
  steps: readonly StepRow[];
}

/**
 * How much of the next leg is worth showing.
 *
 * Three. Enough to see which way they will be sent out of the street, not
 * enough to read as a second set of instructions competing with the first —
 * and short enough that the whole of the current leg stays above it.
 */
const NEXT_STEPS_SHOWN = 3;

export function StepList({
  steps,
  arrival,
  next,
}: {
  steps: readonly StepRow[];
  arrival: ArrivalRow;
  next?: NextLegRow | null;
}) {
  const colors = useNavColors();

  return (
    <View>
      {steps.map((step, index) => (
        <StepRowView
          arrival={step.maneuver === 'ARRIVE' ? arrival : null}
          key={`step-${index}-${step.instruction}`}
          step={step}
        />
      ))}

      {next ? (
        <View>
          <View style={{ backgroundColor: colors.subtleFill }} className="px-4 py-2">
            <Text
              className="text-2xs font-bold uppercase tracking-wider"
              style={{ color: colors.muted }}
            >
              Then stop {next.position} · {navDuration(next.driveSeconds)} ·{' '}
              {navMiles(next.driveMeters)}
            </Text>
          </View>
          {/* Dimmed as a group rather than row by row, so the block reads as
              one provisional thing instead of as rows that failed to load. */}
          <View style={{ opacity: 0.62 }}>
            {next.steps.slice(0, NEXT_STEPS_SHOWN).map((step, index) => (
              <StepRowView arrival={null} key={`next-${index}-${step.instruction}`} step={step} />
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}

function StepRowView({ step, arrival }: { step: StepRow; arrival: ArrivalRow | null }) {
  const colors = useNavColors();
  const side = arrival?.side === 'LEFT' ? 'On the left' : arrival?.side === 'RIGHT' ? 'On the right' : null;

  return (
    <View
      accessible
      accessibilityLabel={
        arrival
          ? `${step.instruction}. Stop ${arrival.position} of ${arrival.total}, ${arrival.inspectionType}, ${arrival.etaLabel}.${side ? ` ${side}.` : ''}`
          : `${step.instruction}. ${navDistance(step.distanceMeters)}.`
      }
      className="flex-row items-start gap-3 px-4 py-3"
      style={arrival ? { backgroundColor: colors.wash } : undefined}
    >
      <View className="w-[30px] items-center pt-0.5">
        <ManeuverIcon color={arrival ? colors.washText : colors.text} maneuver={step.maneuver} size={24} />
      </View>

      <View className="min-w-0 flex-1">
        <Instruction
          color={arrival ? colors.washText : colors.text}
          instruction={step.instruction}
          roadName={step.roadName}
        />
        {arrival ? (
          <Text className="mt-0.5 text-xs" style={{ color: colors.washText }}>
            Stop {arrival.position} of {arrival.total} · {arrival.inspectionType} ·{' '}
            {arrival.etaLabel}
          </Text>
        ) : null}
      </View>

      <Text
        className="text-right text-[13px]"
        style={{ color: arrival ? colors.washText : colors.muted, minWidth: 64 }}
      >
        {side ?? navDistance(step.distanceMeters)}
      </Text>
    </View>
  );
}

/**
 * The instruction, with the road name carrying the weight.
 *
 * The router's sentence is never rewritten — it is the one part of a step that
 * is right even when the maneuver enum is not — so the road is emphasised
 * *within* it rather than pulled out and printed separately. When the name does
 * not appear in the sentence (OSRM sometimes gives a ref like "US-290 E" while
 * the text says "the highway"), the sentence is drawn plain: a bolded fragment
 * that is not in the text would look like a rendering fault.
 */
function Instruction({
  instruction,
  roadName,
  color,
}: {
  instruction: string;
  roadName: string | null;
  color: string;
}) {
  const at = roadName ? instruction.indexOf(roadName) : -1;

  if (!roadName || at < 0) {
    return (
      <Text className="text-[15px]" style={{ color }}>
        {instruction}
      </Text>
    );
  }

  return (
    <Text className="text-[15px]" style={{ color }}>
      {instruction.slice(0, at)}
      <Text className="font-semibold">{roadName}</Text>
      {instruction.slice(at + roadName.length)}
    </Text>
  );
}
