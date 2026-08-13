/**
 * The PDF rendering of an inspection report.
 *
 * This file owns presentation only. Every decision about *what* appears, in
 * what order, and how it is worded comes from the shared `ReportView`, which
 * the public web page renders too — see shared/src/report/report-view.ts. Keep
 * it that way: content logic added here silently diverges from the web report.
 */
import { Document, Image, Page, StyleSheet, Text, View } from '@react-pdf/renderer';
import { REPORT_PALETTE } from '@texasrenters/shared';
import type { ReportFindingView, ReportRoomView, ReportView } from '@texasrenters/shared';

const C = REPORT_PALETTE;

/** Photo bytes keyed by photo id, as data URIs. */
export type ReportImages = Map<string, string>;

const styles = StyleSheet.create({
  page: {
    paddingTop: 46,
    paddingBottom: 56,
    paddingHorizontal: 44,
    fontSize: 9.5,
    lineHeight: 1.5,
    color: C.text,
    backgroundColor: C.surface,
    fontFamily: 'Helvetica',
  },

  // ---- cover -------------------------------------------------------------
  coverBand: {
    backgroundColor: C.brand,
    marginHorizontal: -44,
    marginTop: -46,
    paddingHorizontal: 44,
    paddingTop: 46,
    paddingBottom: 30,
    marginBottom: 26,
  },
  coverKicker: {
    color: '#a9c0ee',
    fontSize: 8.5,
    letterSpacing: 2.2,
    fontFamily: 'Helvetica-Bold',
    marginBottom: 12,
  },
  coverTitle: { color: '#ffffff', fontSize: 23, fontFamily: 'Helvetica-Bold', lineHeight: 1.25 },
  coverSubtitle: { color: '#cfdcf5', fontSize: 11, marginTop: 5 },
  coverMetaRow: { flexDirection: 'row', marginTop: 18, gap: 26 },
  coverMetaLabel: { color: '#a9c0ee', fontSize: 7.5, letterSpacing: 1.1 },
  coverMetaValue: { color: '#ffffff', fontSize: 10.5, fontFamily: 'Helvetica-Bold', marginTop: 3 },

  // ---- generic -----------------------------------------------------------
  sectionTitle: { fontSize: 13, fontFamily: 'Helvetica-Bold', marginBottom: 3 },
  sectionHint: { color: C.muted, marginBottom: 12 },
  rule: { height: 2, backgroundColor: C.accent, width: 34, marginBottom: 14, marginTop: 6 },

  statRow: { flexDirection: 'row', gap: 10, marginBottom: 20 },
  statCard: {
    flexGrow: 1,
    flexBasis: 0,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 6,
    padding: 11,
    backgroundColor: C.surfaceSubtle,
  },
  statValue: { fontSize: 19, fontFamily: 'Helvetica-Bold' },
  statLabel: { color: C.muted, fontSize: 8, marginTop: 2 },

  chip: {
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 2.5,
    paddingHorizontal: 8,
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
  },

  // ---- rooms -------------------------------------------------------------
  roomCard: { borderWidth: 1, borderColor: C.border, borderRadius: 6, marginBottom: 14 },
  roomHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: C.surfaceSubtle,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  roomName: { fontSize: 11.5, fontFamily: 'Helvetica-Bold' },
  roomFloor: { color: C.muted, fontSize: 8.5, marginTop: 1 },
  roomBody: { padding: 12 },

  photoGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  photoCell: { width: 152 },
  photo: {
    width: 152,
    height: 114,
    objectFit: 'cover',
    borderRadius: 4,
    borderWidth: 1,
    borderColor: C.border,
  },
  photoCaption: { fontSize: 7.5, fontFamily: 'Helvetica-Bold', marginTop: 3 },
  photoStamp: { fontSize: 7, color: C.muted },

  findingRow: {
    flexDirection: 'row',
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: C.border,
  },
  severityBar: { width: 3, borderRadius: 2, marginRight: 9 },
  findingTitle: { fontSize: 10, fontFamily: 'Helvetica-Bold' },
  findingMeta: { color: C.muted, fontSize: 8, marginTop: 1, marginBottom: 3 },
  baseline: {
    marginTop: 4,
    paddingLeft: 7,
    borderLeftWidth: 1,
    borderLeftColor: C.border,
    color: C.muted,
    fontSize: 8.5,
  },
  emptyRoom: { color: C.muted, fontSize: 8.5 },
  // The condition table. Column widths are fixed rather than proportional so
  // the three verdict columns line up down the page the way the office's
  // printed reports do.
  checklistTable: { marginBottom: 8 },
  checklistRow: { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: C.border },
  checklistHeadRow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: C.border },
  checklistHeadCell: { fontSize: 7, color: C.muted, paddingVertical: 3, paddingHorizontal: 4 },
  checklistCell: { fontSize: 8, paddingVertical: 3, paddingHorizontal: 4 },
  checklistLabel: { width: '32%' },
  checklistAxis: { width: '11%', textAlign: 'center' },
  checklistComment: { width: '35%', color: C.muted },
  quietRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 5,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },

  // ---- closing -----------------------------------------------------------
  closingRow: { flexDirection: 'row', gap: 12, marginTop: 10, marginBottom: 4 },
  closingCell: { flex: 1 },
  closingBody: { fontSize: 8.5, lineHeight: 1.4, marginTop: 2 },
  disclaimer: {
    marginTop: 16,
    padding: 12,
    backgroundColor: C.brandSoft,
    borderRadius: 6,
    fontSize: 8.5,
    color: C.brandDark,
    lineHeight: 1.6,
  },
  brandLine: { color: C.muted, fontSize: 8, marginTop: 10 },

  // ---- running furniture -------------------------------------------------
  footer: {
    position: 'absolute',
    bottom: 26,
    left: 44,
    right: 44,
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderTopColor: C.border,
    paddingTop: 7,
    fontSize: 7.5,
    color: C.muted,
  },

  grow: { flexGrow: 1, flexBasis: 0 },
  spread: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
});

type Tone = { accent: string; surface: string; border: string };

const INSPECTED_TONE: Tone = { accent: C.accentDark, surface: C.accentSoft, border: '#cbe4a8' };
const QUIET_TONE: Tone = { accent: C.muted, surface: C.surfaceSubtle, border: C.border };

function Chip({ label, tone }: { label: string; tone: Tone }) {
  return (
    <Text
      style={[
        styles.chip,
        { color: tone.accent, backgroundColor: tone.surface, borderColor: tone.border },
      ]}
    >
      {label}
    </Text>
  );
}

function Finding({ finding }: { finding: ReportFindingView }) {
  return (
    <View style={styles.findingRow} wrap={false}>
      <View style={[styles.severityBar, { backgroundColor: finding.tone.accent }]} />
      <View style={styles.grow}>
        <View style={styles.spread}>
          <Text style={[styles.findingTitle, styles.grow, { paddingRight: 8 }]}>
            {finding.title}
          </Text>
          <Chip label={finding.severityLabel} tone={finding.tone} />
        </View>
        <Text style={styles.findingMeta}>
          {finding.categoryLabel} · {finding.comparisonLabel}
        </Text>
        <Text>{finding.description}</Text>
        {finding.baselineCondition ? (
          <Text style={styles.baseline}>At move-in: {finding.baselineCondition}</Text>
        ) : null}
      </View>
    </View>
  );
}

/**
 * The condition table, printed before the photographs.
 *
 * An unassessed axis renders as an empty cell rather than "N" — the view model
 * already made that decision, so this renderer and the HTML page cannot
 * disagree about what a blank means.
 */
function ChecklistTable({ room }: { room: ReportRoomView }) {
  if (!room.checklist.length) return null;
  return (
    <View style={styles.checklistTable}>
      <View style={styles.checklistHeadRow}>
        <Text style={[styles.checklistHeadCell, styles.checklistLabel]}>Room / item</Text>
        <Text style={[styles.checklistHeadCell, styles.checklistAxis]}>Clean</Text>
        <Text style={[styles.checklistHeadCell, styles.checklistAxis]}>Undam.</Text>
        <Text style={[styles.checklistHeadCell, styles.checklistAxis]}>Working</Text>
        <Text style={[styles.checklistHeadCell, styles.checklistComment]}>Comments</Text>
      </View>
      {room.checklist.map((row) => (
        <View key={row.id} style={styles.checklistRow} wrap={false}>
          <Text style={[styles.checklistCell, styles.checklistLabel]}>{row.label}</Text>
          <Text style={[styles.checklistCell, styles.checklistAxis]}>{row.clean}</Text>
          <Text style={[styles.checklistCell, styles.checklistAxis]}>{row.undamaged}</Text>
          <Text style={[styles.checklistCell, styles.checklistAxis]}>{row.working}</Text>
          <Text style={[styles.checklistCell, styles.checklistComment]}>{row.comment}</Text>
        </View>
      ))}
    </View>
  );
}

function Room({ room, images }: { room: ReportRoomView; images: ReportImages }) {
  const photos = room.photos.filter((photo) => images.has(photo.id));
  return (
    // Small rooms stay whole on one page; large ones are allowed to split
    // rather than leaving most of a page blank.
    <View
      style={styles.roomCard}
      wrap={room.checklist.length + photos.length + room.findings.length > 4}
    >
      <View style={styles.roomHeader}>
        <View>
          <Text style={styles.roomName}>{room.name}</Text>
          {room.floorName ? <Text style={styles.roomFloor}>{room.floorName}</Text> : null}
        </View>
        <Chip label={room.statusLabel} tone={room.inspected ? INSPECTED_TONE : QUIET_TONE} />
      </View>
      <View style={styles.roomBody}>
        <ChecklistTable room={room} />
        {photos.length ? (
          <View style={styles.photoGrid}>
            {photos.map((photo) => (
              <View key={photo.id} style={styles.photoCell} wrap={false}>
                <Image style={styles.photo} src={images.get(photo.id)!} />
                {photo.caption ? <Text style={styles.photoCaption}>{photo.caption}</Text> : null}
                {photo.stamp ? <Text style={styles.photoStamp}>{photo.stamp}</Text> : null}
              </View>
            ))}
          </View>
        ) : null}
        {room.findings.map((finding) => (
          <Finding key={finding.id} finding={finding} />
        ))}
        {!room.checklist.length && !photos.length && !room.findings.length ? (
          <Text style={styles.emptyRoom}>
            {room.skipReason
              ? `Not inspected — ${room.skipReason}`
              : 'No issues were recorded for this room.'}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function Footer({ address }: { address: string }) {
  return (
    <View style={styles.footer} fixed>
      <Text>{address}</Text>
      <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
    </View>
  );
}

export function ReportDocument({ view, images }: { view: ReportView; images: ReportImages }) {
  const address = [view.title, view.subtitle].filter(Boolean).join(' · ');
  const roomsWithEvidence = view.rooms.filter((room) => room.hasEvidence);
  const quietRooms = view.rooms.filter((room) => !room.hasEvidence);

  return (
    <Document
      title={`Inspection report — ${view.title}`}
      author={view.brand.name}
      subject={view.inspectionLabel}
      creator={view.brand.name}
      producer={view.brand.name}
    >
      <Page size="LETTER" style={styles.page}>
        <View style={styles.coverBand}>
          <Text style={styles.coverKicker}>{view.brand.name.toUpperCase()}</Text>
          <Text style={styles.coverTitle}>{view.title}</Text>
          {view.subtitle ? <Text style={styles.coverSubtitle}>{view.subtitle}</Text> : null}
          {/* Matches the office's letterhead: the form used, who carried it
              out, and when. The inspector is omitted rather than shown blank
              when nobody is assigned. */}
          <View style={styles.coverMetaRow}>
            <View>
              <Text style={styles.coverMetaLabel}>INSPECTION TEMPLATE</Text>
              <Text style={styles.coverMetaValue}>{view.templateLabel}</Text>
            </View>
            {view.inspectorLabel ? (
              <View>
                <Text style={styles.coverMetaLabel}>INSPECTOR</Text>
                <Text style={styles.coverMetaValue}>{view.inspectorLabel}</Text>
              </View>
            ) : null}
            <View>
              <Text style={styles.coverMetaLabel}>DATE</Text>
              <Text style={styles.coverMetaValue}>{view.dateLabel}</Text>
            </View>
          </View>
        </View>

        <Text style={styles.sectionTitle}>At a glance</Text>
        <View style={styles.rule} />
        <View style={styles.statRow}>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>
              {view.summary.roomsInspected}/{view.summary.roomsTotal}
            </Text>
            <Text style={styles.statLabel}>Rooms inspected</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>{view.summary.findingsTotal}</Text>
            <Text style={styles.statLabel}>Findings reviewed</Text>
          </View>
          {view.summary.severityCounts.map((entry) => (
            <View key={entry.severity} style={styles.statCard}>
              <Text style={[styles.statValue, { color: entry.tone.accent }]}>{entry.count}</Text>
              <Text style={styles.statLabel}>{entry.label}</Text>
            </View>
          ))}
        </View>

        <Text style={styles.sectionTitle}>Summary of findings</Text>
        {view.summary.findingsTotal ? (
          <>
            <Text style={styles.sectionHint}>{view.summary.headline}, most significant first.</Text>
            {view.allFindings.map((finding) => (
              <View key={finding.id} style={{ flexDirection: 'row', marginBottom: 6 }} wrap={false}>
                <View style={[styles.severityBar, { backgroundColor: finding.tone.accent }]} />
                <View style={styles.grow}>
                  <Text style={styles.findingTitle}>{finding.title}</Text>
                  <Text style={styles.findingMeta}>
                    {finding.roomName} · {finding.comparisonLabel}
                  </Text>
                </View>
                <Chip label={finding.severityLabel} tone={finding.tone} />
              </View>
            ))}
          </>
        ) : (
          <Text style={styles.sectionHint}>
            No findings were confirmed during review of this inspection.
          </Text>
        )}

        <Footer address={address} />
      </Page>

      <Page size="LETTER" style={styles.page}>
        <Text style={styles.sectionTitle}>Room by room</Text>
        <Text style={styles.sectionHint}>
          Photographs and reviewed findings for each area of the property.
        </Text>
        {roomsWithEvidence.map((room) => (
          <Room key={room.id} room={room} images={images} />
        ))}

        {quietRooms.length ? (
          <View wrap={false}>
            <Text style={[styles.sectionTitle, { marginTop: 6 }]}>Other areas</Text>
            <Text style={styles.sectionHint}>
              Inspected with nothing to report, or not accessible on the day.
            </Text>
            {quietRooms.map((room) => (
              <View key={room.id} style={styles.quietRow}>
                <Text>
                  {room.name}
                  {room.floorName ? ` · ${room.floorName}` : ''}
                  {room.skipReason ? ` — ${room.skipReason}` : ''}
                </Text>
                <Text style={{ color: C.muted }}>{room.statusLabel}</Text>
              </View>
            ))}
          </View>
        ) : null}

        {view.otherFindings.length ? (
          <View>
            <Text style={[styles.sectionTitle, { marginTop: 14 }]}>Additional findings</Text>
            <Text style={styles.sectionHint}>
              Recorded against areas that have since been renamed or merged.
            </Text>
            {view.otherFindings.map((finding) => (
              <Finding key={finding.id} finding={finding} />
            ))}
          </View>
        ) : null}

        {/* Closing block, last and before the disclaimer, where the office's
            own report puts it. Kept whole on one page: splitting a maintenance
            list across a page break is how items get missed. */}
        {view.closingNotes.length ? (
          <View style={styles.closingRow} wrap={false}>
            {view.closingNotes.map((note) => (
              <View key={note.label} style={styles.closingCell}>
                <Text style={styles.coverMetaLabel}>{note.label.toUpperCase()}</Text>
                <Text style={styles.closingBody}>{note.body}</Text>
              </View>
            ))}
          </View>
        ) : null}

        <View style={styles.disclaimer}>
          <Text>{view.disclaimer}</Text>
        </View>
        <Text style={styles.brandLine}>
          {[
            view.brand.name,
            view.brand.addressLine1,
            view.brand.addressLine2,
            view.brand.phone,
            view.brand.email,
          ]
            .filter(Boolean)
            .join(' · ')}
        </Text>
        <Text style={[styles.brandLine, { marginTop: 2 }]}>Generated {view.generatedLabel}</Text>

        <Footer address={address} />
      </Page>
    </Document>
  );
}
