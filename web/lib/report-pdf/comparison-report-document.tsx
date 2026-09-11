/**
 * The PDF rendering of a comparison report.
 *
 * Presentation only. What appears, in what order, and how it is worded is
 * decided by the payload and by the shared classification labels the console
 * uses — a row that reads "New damage" on screen must read the same here, on the
 * document somebody may be disputing.
 */
import { Document, Image, Page, StyleSheet, Text, View } from '@react-pdf/renderer';
import { REPORT_PALETTE } from '@texasrenters/shared';
import type {
  ComparisonReport,
  ComparisonReportAreaSide,
  PublicReportChecklistItem,
} from '@texasrenters/shared';

import { CLASSIFICATION_VARIANT, classLabel } from '@/lib/comparison-classification';

const C = REPORT_PALETTE;

/** Photo bytes keyed by photo id, as data URIs. */
export type ReportImages = Map<string, string>;

/**
 * The console's badge variants, given ink.
 *
 * Mapped rather than re-decided so the two cannot disagree about which verdicts
 * are the expensive ones.
 */
const VARIANT_TONE: Record<string, { accent: string; surface: string; border: string }> = {
  destructive: { accent: '#b64040', surface: '#f8e1e1', border: '#e9bcbc' },
  warning: { accent: '#94601b', surface: '#f8ebd2', border: '#e6cf9f' },
  success: { accent: C.accentDark, surface: C.accentSoft, border: '#cfe3b5' },
  secondary: { accent: C.muted, surface: C.surfaceSubtle, border: C.border },
};

const styles = StyleSheet.create({
  page: {
    paddingTop: 40,
    paddingBottom: 48,
    paddingHorizontal: 38,
    fontSize: 9,
    lineHeight: 1.45,
    color: C.text,
    backgroundColor: C.surface,
    fontFamily: 'Helvetica',
  },
  band: {
    backgroundColor: C.brand,
    marginHorizontal: -38,
    marginTop: -40,
    paddingHorizontal: 38,
    paddingTop: 40,
    paddingBottom: 24,
    marginBottom: 20,
  },
  kicker: {
    color: '#a9c0ee',
    fontSize: 8,
    letterSpacing: 2,
    fontFamily: 'Helvetica-Bold',
    marginBottom: 10,
  },
  title: { color: '#ffffff', fontSize: 20, fontFamily: 'Helvetica-Bold' },
  subtitle: { color: '#cfdcf5', fontSize: 10, marginTop: 4 },

  sides: { flexDirection: 'row', gap: 18, marginBottom: 14 },
  side: { flex: 1 },
  sideRule: { borderLeftWidth: 1, borderLeftColor: C.border, paddingLeft: 18 },
  sideLabel: {
    fontSize: 7.5,
    letterSpacing: 1.4,
    color: C.muted,
    fontFamily: 'Helvetica-Bold',
    marginBottom: 3,
  },
  sideTitle: { fontFamily: 'Helvetica-Bold' },
  muted: { color: C.muted },

  area: {
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 4,
    padding: 12,
    marginBottom: 10,
  },
  areaHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  areaName: { fontSize: 11, fontFamily: 'Helvetica-Bold' },
  chip: {
    borderWidth: 1,
    borderRadius: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
  },

  row: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: C.border, paddingVertical: 2 },
  headRow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: C.text, paddingBottom: 2 },
  itemCell: { flex: 1, paddingRight: 4 },
  gradeCell: { width: 16, textAlign: 'center' },
  gradeHead: { width: 16, textAlign: 'center', fontFamily: 'Helvetica-Bold', fontSize: 7.5 },
  pass: { color: C.pass, fontFamily: 'Helvetica-Bold' },
  fail: { color: C.fail, fontFamily: 'Helvetica-Bold' },

  photos: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 6 },
  photo: { width: 68, height: 50, objectFit: 'cover', borderRadius: 2 },

  empty: {
    color: C.muted,
    fontStyle: 'italic',
    borderWidth: 1,
    borderColor: C.border,
    borderStyle: 'dashed',
    borderRadius: 3,
    padding: 8,
  },
  footer: {
    position: 'absolute',
    bottom: 24,
    left: 38,
    right: 38,
    fontSize: 7.5,
    color: C.muted,
    textAlign: 'center',
  },
});

/** Tri-state: null is "not assessed" and prints as a dash, never as a failure. */
function Grade({ value }: { value: boolean | null | undefined }) {
  if (value === null || value === undefined) return <Text style={styles.muted}>—</Text>;
  return <Text style={value ? styles.pass : styles.fail}>{value ? 'Y' : 'N'}</Text>;
}

function graded(checklist: PublicReportChecklistItem[]) {
  return checklist.filter(
    (item) => item.isClean !== null || item.isUndamaged !== null || item.isWorking !== null,
  );
}

function Side({
  side,
  label,
  images,
  ruled,
}: {
  side: ComparisonReportAreaSide | null;
  label: string;
  images: ReportImages;
  ruled?: boolean;
}) {
  const style = ruled ? [styles.side, styles.sideRule] : styles.side;
  if (!side)
    return (
      <View style={style}>
        <Text style={styles.empty}>No {label} record for this area.</Text>
      </View>
    );

  const rows = graded(side.checklist);
  return (
    <View style={style}>
      {rows.length > 0 ? (
        <View>
          <View style={styles.headRow}>
            <Text style={styles.itemCell}>Item</Text>
            <Text style={styles.gradeHead}>C</Text>
            <Text style={styles.gradeHead}>U</Text>
            <Text style={styles.gradeHead}>W</Text>
          </View>
          {rows.map((item) => (
            <View key={item.id} style={styles.row} wrap={false}>
              <Text style={styles.itemCell}>{item.label}</Text>
              <View style={styles.gradeCell}>
                <Grade value={item.isClean} />
              </View>
              <View style={styles.gradeCell}>
                <Grade value={item.isUndamaged} />
              </View>
              <View style={styles.gradeCell}>
                <Grade value={item.isWorking} />
              </View>
            </View>
          ))}
        </View>
      ) : (
        <Text style={styles.muted}>No condition was graded here.</Text>
      )}

      {side.findings.map((finding) => (
        <Text key={finding.id} style={{ marginTop: 4 }}>
          <Text style={styles.sideTitle}>{finding.title}</Text>
          {finding.description ? <Text style={styles.muted}> — {finding.description}</Text> : null}
        </Text>
      ))}

      {side.photos.length > 0 ? (
        <View style={styles.photos}>
          {side.photos.map((photo) => {
            const source = images.get(photo.id);
            // A photograph that could not be fetched is omitted rather than
            // failing the download; the document is more useful without it.
            return source ? <Image key={photo.id} src={source} style={styles.photo} /> : null;
          })}
        </View>
      ) : null}
    </View>
  );
}

export function ComparisonReportDocument({
  report,
  images,
}: {
  report: ComparisonReport;
  images: ReportImages;
}) {
  const address =
    [
      report.property.addressLine1,
      report.property.unitName,
      [report.property.city, report.property.state].filter(Boolean).join(', '),
      report.property.postalCode,
    ]
      .filter(Boolean)
      .join(' · ') || report.property.name;

  const overall = VARIANT_TONE[CLASSIFICATION_VARIANT[report.comparison.overallCondition] ?? 'secondary'];

  return (
    <Document title={`Comparison report — ${address}`}>
      <Page size="A4" style={styles.page}>
        <View style={styles.band}>
          <Text style={styles.kicker}>{report.brand.name.toUpperCase()}</Text>
          <Text style={styles.title}>Comparison report</Text>
          <Text style={styles.subtitle}>{address}</Text>
        </View>

        {/* Move-in left, move-out right — the same order every area uses below. */}
        <View style={styles.sides}>
          <View style={styles.side}>
            <Text style={styles.sideLabel}>MOVE-IN</Text>
            <Text style={styles.sideTitle}>
              {report.moveIn.templateLabel ?? report.moveIn.type}
            </Text>
            <Text style={styles.muted}>
              {formatDay(report.moveIn.completedAt ?? report.moveIn.scheduledAt)}
            </Text>
            <Text style={styles.muted}>{report.moveIn.inspector ?? '—'}</Text>
          </View>
          <View style={[styles.side, styles.sideRule]}>
            <Text style={styles.sideLabel}>MOVE-OUT</Text>
            <Text style={styles.sideTitle}>
              {report.moveOut.templateLabel ?? report.moveOut.type}
            </Text>
            <Text style={styles.muted}>
              {formatDay(report.moveOut.completedAt ?? report.moveOut.scheduledAt)}
            </Text>
            <Text style={styles.muted}>{report.moveOut.inspector ?? '—'}</Text>
          </View>
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 14 }}>
          <Text
            style={[
              styles.chip,
              { color: overall.accent, backgroundColor: overall.surface, borderColor: overall.border },
            ]}
          >
            {classLabel(report.comparison.overallCondition)}
          </Text>
          <Text style={styles.muted}>{report.comparison.summary}</Text>
        </View>

        {report.areas.map((area) => {
          const tone = VARIANT_TONE[CLASSIFICATION_VARIANT[area.classification] ?? 'secondary'];
          return (
            <View key={area.id} style={styles.area} wrap={false}>
              <View style={styles.areaHead}>
                <Text style={styles.areaName}>
                  {area.areaName}
                  {area.floorName ? <Text style={styles.muted}> {area.floorName}</Text> : null}
                </Text>
                <Text
                  style={[
                    styles.chip,
                    { color: tone.accent, backgroundColor: tone.surface, borderColor: tone.border },
                  ]}
                >
                  {classLabel(area.classification)}
                </Text>
              </View>
              {area.summary ? <Text style={styles.muted}>{area.summary}</Text> : null}
              {area.overrideReason ? (
                <Text style={styles.muted}>Reviewer: {area.overrideReason}</Text>
              ) : null}
              <View style={[styles.sides, { marginTop: 8, marginBottom: 0 }]}>
                <Side images={images} label="move-in" side={area.moveIn} />
                <Side images={images} label="move-out" ruled side={area.moveOut} />
              </View>
            </View>
          );
        })}

        <Text
          fixed
          render={({ pageNumber, totalPages }) =>
            `${address} · Comparison report · ${pageNumber} of ${totalPages}`
          }
          style={styles.footer}
        />
      </Page>
    </Document>
  );
}

/** Dates are formatted here rather than shipped pre-rendered, as the payload is ISO. */
function formatDay(iso: string | null | undefined) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}
