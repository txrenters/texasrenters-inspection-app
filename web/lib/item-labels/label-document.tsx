import { Document, Page, Path, Rect, StyleSheet, Svg, Text, View } from '@react-pdf/renderer';

import { QUIET_MODULES, qrPath, stripeRuns } from './label-codes';
import { LABEL_PAPERS, labelPages, type Label, type LabelPaper, type LabelPick } from './label-sheets';

/**
 * Item labels as a PDF (2026-11-19): on each, the item code in letters, its
 * description, the stripes and the QR square. Black on white and nothing
 * else: a label is read by a machine before it is read by a person.
 *
 * Drawn as shapes, not pictures, so the bars stay sharp at any printer's
 * resolution. Printed at "actual size": a printer that scales the page to fit
 * moves the labels off the sheet's cuts.
 */

const styles = StyleSheet.create({
  page: { fontFamily: 'Helvetica', color: '#000000' },
  label: { position: 'absolute', flexDirection: 'row', alignItems: 'center', paddingHorizontal: 7, paddingVertical: 5 },
  words: { flexGrow: 1, flexShrink: 1, flexBasis: 0, paddingRight: 6 },
  code: { fontFamily: 'Helvetica-Bold', fontSize: 10 },
  name: { fontSize: 6.5, marginTop: 1, marginBottom: 3 },
});

/** A description that fits one line of a label. */
export const labelName = (label: Pick<Label, 'name' | 'unit'>) => {
  const words = `${label.name} · ${label.unit}`;
  return words.length > 38 ? `${words.slice(0, 37)}…` : words;
};

function Stripes({ code, width, height }: { code: string; width: number; height: number }) {
  const { runs, modules } = stripeRuns(code);
  const whole = modules + QUIET_MODULES * 2;
  return (
    <Svg height={height} preserveAspectRatio="none" viewBox={`0 0 ${whole} 10`} width={width}>
      {runs.map((run) => (
        <Rect fill="#000000" height={10} key={run.at} width={run.width} x={run.at + QUIET_MODULES} y={0} />
      ))}
    </Svg>
  );
}

function Square({ code, side }: { code: string; side: number }) {
  const { size, path } = qrPath(code);
  // Four blank modules all round, as a QR code asks.
  return (
    <Svg height={side} viewBox={`-4 -4 ${size + 8} ${size + 8}`} width={side}>
      <Path d={path} fill="#000000" />
    </Svg>
  );
}

function OneLabel({ label, paper, left, top }: { label: Label; paper: LabelPaper; left: number; top: number }) {
  const { width, height } = LABEL_PAPERS[paper].label;
  const square = paper === 'ROLL' ? 58 : 50;
  const stripes = width - 14 - 6 - square;
  return (
    <View style={[styles.label, { left, top, width, height }]} wrap={false}>
      <View style={styles.words}>
        <Text style={styles.code}>{label.code}</Text>
        <Text style={styles.name}>{labelName(label)}</Text>
        <Stripes code={label.code} height={paper === 'ROLL' ? 30 : 22} width={stripes} />
      </View>
      <Square code={label.code} side={square} />
    </View>
  );
}

export function ItemLabelsDocument({ picks, paper, startAt }: { picks: readonly LabelPick[]; paper: LabelPaper; startAt: number }) {
  const layout = LABEL_PAPERS[paper];
  const pages = labelPages(picks, paper, startAt);
  return (
    <Document title="Item labels">
      {pages.map((places, page) => (
        <Page key={page} size={[layout.page.width, layout.page.height]} style={styles.page}>
          {places.map((label, place) =>
            label ? (
              <OneLabel
                key={place}
                label={label}
                left={layout.left + (place % layout.across) * (layout.label.width + layout.gapAcross)}
                paper={paper}
                top={layout.top + Math.floor(place / layout.across) * layout.label.height}
              />
            ) : null,
          )}
        </Page>
      ))}
    </Document>
  );
}
