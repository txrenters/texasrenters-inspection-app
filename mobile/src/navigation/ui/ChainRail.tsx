import { View } from 'react-native';
import Svg, { Circle, G, Line, Path, Text as SvgText } from 'react-native-svg';

import { useNavColors } from './nav-colors';

/**
 * The whole day on one line: what is done, what is being driven, what is left.
 *
 * ## Why this exists at all
 *
 * Every other navigator on the phone knows about one destination. This one is
 * driving somebody's working day, and the question a technician actually asks
 * at a stop is not "how far to this address" — it is "how much of this is
 * left". A list answers that badly: it has to be scrolled, it does not show
 * where you are in it, and it cannot be read at a glance from a driving seat.
 * One rail can.
 *
 * ## Why the later segments are dotted rather than solid
 *
 * A solid line the whole way across claims the rest of the day is settled, and
 * it is not: the order is a suggestion that is recomputed from wherever the
 * technician actually ends up (see `DayRouteSummary` — "a suggestion, never an
 * instruction"), and the drive times past the next stop are estimates of
 * estimates. The dots say provisional without a sentence.
 *
 * ## The layout rule
 *
 * Nodes are spaced evenly between a fixed inset, so two stops and eight stops
 * both fill the rail. The inset is the current node's halo radius plus a
 * margin, because the halo is the widest thing drawn and a node at either end
 * would otherwise be clipped. At eight stops the spacing is 45px against a 35px
 * halo — tight, but not touching. Past eight the drive-time labels would
 * collide, so they are dropped rather than overlapped.
 */

export type ChainStopState = 'DONE' | 'CURRENT' | 'LATER';

export interface ChainStop {
  /** 1-based position in the day, which is what the node prints. */
  position: number;
  state: ChainStopState;
}

export interface ChainLeg {
  /** The drive between two stops, already worded — "18 min". */
  label: string | null;
}

const WIDTH = 358;
const HEIGHT = 58;
/** Halo radius (17.5) plus a little, so an end node cannot be clipped. */
const INSET = 20;
const RAIL_Y = 30;
const LABEL_Y = 13;
const CAPTION_Y = 51;
/** Below this gap a "18 min" at 9px would run into its neighbour. */
const LABEL_MIN_GAP = 34;

export function ChainRail({
  stops,
  legs = [],
  width = WIDTH,
  height = HEIGHT,
}: {
  stops: readonly ChainStop[];
  /** `legs[i]` is the drive from `stops[i]` to `stops[i + 1]`. */
  legs?: readonly ChainLeg[];
  width?: number;
  height?: number;
}) {
  const colors = useNavColors();
  if (stops.length === 0) return null;

  const span = width - INSET * 2;
  const gap = stops.length > 1 ? span / (stops.length - 1) : 0;
  const centreAt = (index: number) => (stops.length > 1 ? INSET + gap * index : width / 2);
  const showLabels = gap >= LABEL_MIN_GAP;

  const done = stops.filter((stop) => stop.state === 'DONE').length;
  const current = stops.find((stop) => stop.state === 'CURRENT');

  return (
    <View
      accessible
      accessibilityLabel={
        current
          ? `Stop ${current.position} of ${stops.length}. ${done} done.`
          : `${done} of ${stops.length} stops done.`
      }
      accessibilityRole="progressbar"
    >
      <Svg height={height} width={width}>
        {stops.slice(0, -1).map((stop, index) => {
          const next = stops[index + 1];
          if (!next) return null;
          // A segment takes its state from the stop it leads *to*: the drive
          // into a finished stop is finished, the drive into the current stop
          // is the one being driven. Reading it from the stop it leaves would
          // paint the active drive as done the moment the previous stop closed.
          const state = next.state;
          const x1 = centreAt(index);
          const x2 = centreAt(index + 1);
          const label = legs[index]?.label ?? null;

          return (
            <G key={`segment-${stop.position}-${next.position}`}>
              <Line
                opacity={state === 'LATER' ? 0.5 : 1}
                stroke={
                  state === 'DONE'
                    ? colors.routeDriven
                    : state === 'CURRENT'
                      ? colors.routeActive
                      : colors.nodeRing
                }
                strokeDasharray={state === 'LATER' ? '0.1 8' : undefined}
                strokeLinecap="round"
                strokeWidth={state === 'CURRENT' ? 4.5 : 3.5}
                x1={x1}
                x2={x2}
                y1={RAIL_Y}
                y2={RAIL_Y}
              />
              {showLabels && label ? (
                <SvgText
                  fill={state === 'CURRENT' ? colors.routeActive : colors.muted}
                  fontSize={9}
                  fontWeight={state === 'CURRENT' ? '700' : '500'}
                  textAnchor="middle"
                  x={(x1 + x2) / 2}
                  y={LABEL_Y}
                >
                  {label}
                </SvgText>
              ) : null}
            </G>
          );
        })}

        {stops.map((stop, index) => (
          <ChainNode
            cx={centreAt(index)}
            doneColor={colors.routeDriven}
            key={`stop-${stop.position}`}
            numberColor={colors.surface}
            currentColor={colors.routeActive}
            ringColor={colors.nodeRing}
            stop={stop}
            surface={colors.surface}
          />
        ))}

        {/* Three words for three zones, not one word per node. A caption under
            every circle spells out "Done Done Done Driving Later Later", which
            is six labels saying what the shapes already say — and at 9px it
            reads as a wall of grey rather than as three regions. */}
        {captionZones(stops).map((zone) => (
          <SvgText
            fill={zone.state === 'CURRENT' ? colors.routeActive : colors.muted}
            fontSize={9}
            fontWeight={zone.state === 'CURRENT' ? '700' : '500'}
            key={zone.state}
            textAnchor="middle"
            x={(centreAt(zone.from) + centreAt(zone.to)) / 2}
            y={CAPTION_Y}
          >
            {zone.label}
          </SvgText>
        ))}
      </Svg>
    </View>
  );
}

/** The spans each caption sits under, skipping the ones with no nodes in them. */
function captionZones(
  stops: readonly ChainStop[],
): { state: ChainStopState; label: string; from: number; to: number }[] {
  const labels: Record<ChainStopState, string> = {
    DONE: 'Done',
    CURRENT: 'Driving',
    LATER: 'Later',
  };

  return (['DONE', 'CURRENT', 'LATER'] as const).flatMap((state) => {
    const indices = stops.flatMap((stop, index) => (stop.state === state ? [index] : []));
    const first = indices[0];
    const last = indices[indices.length - 1];
    if (first === undefined || last === undefined) return [];
    return [{ state, label: labels[state], from: first, to: last }];
  });
}

function ChainNode({
  stop,
  cx,
  doneColor,
  currentColor,
  ringColor,
  numberColor,
  surface,
}: {
  stop: ChainStop;
  cx: number;
  doneColor: string;
  currentColor: string;
  ringColor: string;
  numberColor: string;
  surface: string;
}) {
  return (
    <G>
      {stop.state === 'CURRENT' ? (
        <>
          {/* The halo is what the eye finds first when the rail is glanced at
              rather than read. It is drawn at a low opacity of the disc's own
              colour instead of a separate tint, so it survives a palette
              change without a second value to keep in step. */}
          <Circle cx={cx} cy={RAIL_Y} fill={currentColor} opacity={0.22} r={17.5} />
          <Circle cx={cx} cy={RAIL_Y} fill={currentColor} r={14} />
          <SvgText
            fill={numberColor}
            fontSize={13}
            fontWeight="700"
            textAnchor="middle"
            x={cx}
            // SVG text sits on its baseline, so a glyph centred on the disc has
            // to be pushed down by roughly a third of its size. `alignmentBaseline`
            // is honoured on iOS and ignored on Android, which put the number
            // half out of the disc on one platform only.
            y={RAIL_Y + 4.6}
          >
            {stop.position}
          </SvgText>
        </>
      ) : null}

      {stop.state === 'DONE' ? (
        <>
          <Circle cx={cx} cy={RAIL_Y} fill={doneColor} r={10} />
          <Path
            d={`M${cx - 4.4} ${RAIL_Y + 0.2} L${cx - 1.2} ${RAIL_Y + 3.4} L${cx + 4.6} ${RAIL_Y - 3.2}`}
            fill="none"
            stroke={surface}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2.2}
          />
        </>
      ) : null}

      {stop.state === 'LATER' ? (
        <Circle cx={cx} cy={RAIL_Y} fill={surface} r={10} stroke={ringColor} strokeWidth={2} />
      ) : null}
    </G>
  );
}
