/**
 * The PDF of a move-in / move-out comparison, for the owner or tenant a link
 * was sent to.
 *
 * Presentation only, as for the inspection report's PDF (`report-document`):
 * what appears and in what words is the shared `ComparisonView`, which the web
 * page renders too. Content logic added here would silently diverge from it.
 */
import { Document, Image, Page, StyleSheet, Text, View } from '@react-pdf/renderer';
import { comparisonItemList, REPORT_PALETTE } from '@texasrenters/shared';
import type {
  ComparisonFindingView,
  ComparisonRoomView,
  ComparisonSideView,
  ComparisonView,
  ReportTone,
} from '@texasrenters/shared';

import type { ReportImages } from './report-document';

const C = REPORT_PALETTE;

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
  coverBand: {
    backgroundColor: C.brand,
    marginHorizontal: -44,
    marginTop: -46,
    paddingHorizontal: 44,
    paddingTop: 46,
    paddingBottom: 28,
    marginBottom: 24,
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
  coverMetaSub: { color: '#cfdcf5', fontSize: 8.5, marginTop: 1 },

  sectionTitle: { fontSize: 13, fontFamily: 'Helvetica-Bold', marginBottom: 3 },
  sectionHint: { color: C.muted, marginBottom: 10 },
  rule: { height: 2, backgroundColor: C.accent, width: 34, marginBottom: 14, marginTop: 6 },

  statRow: { flexDirection: 'row', gap: 10, marginBottom: 18 },
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

  summaryHeading: {
    color: C.muted,
    fontSize: 7.5,
    letterSpacing: 1.1,
    fontFamily: 'Helvetica-Bold',
    marginTop: 8,
    marginBottom: 3,
  },
  summaryLine: { marginBottom: 2 },
  bold: { fontFamily: 'Helvetica-Bold' },
  muted: { color: C.muted },

  chip: {
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 2,
    paddingHorizontal: 7,
    fontSize: 7.5,
    fontFamily: 'Helvetica-Bold',
  },

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
  roomName: { fontSize: 11, fontFamily: 'Helvetica-Bold', textTransform: 'uppercase', letterSpacing: 0.6 },
  roomFloor: { color: C.muted, fontSize: 8.5, marginTop: 1 },
  roomBody: { padding: 12 },
  sentence: { marginBottom: 6 },

  // The item table: four columns that line up down the page.
  table: { marginBottom: 10 },
  headRow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: C.border },
  row: { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: C.border },
  headCell: { fontSize: 7, color: C.muted, paddingVertical: 3, paddingHorizontal: 4 },
  cell: { fontSize: 8, paddingVertical: 3, paddingHorizontal: 4 },
  itemCol: { width: '28%', textTransform: 'uppercase', letterSpacing: 0.4, fontSize: 7.5 },
  sideCol: { width: '24%' },
  changeCol: { width: '24%' },
  comment: { color: C.muted, fontSize: 7, fontStyle: 'italic', marginTop: 1 },
  quiet: { color: C.muted },
  changeText: { fontFamily: 'Helvetica-Bold', fontSize: 7.5 },

  sides: { flexDirection: 'row', gap: 12 },
  side: { flexGrow: 1, flexBasis: 0 },
  sideHeading: {
    color: C.muted,
    fontSize: 7.5,
    letterSpacing: 1,
    fontFamily: 'Helvetica-Bold',
    marginBottom: 5,
  },
  photoGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  photoCell: { width: 112 },
  photoFrame: { position: 'relative', width: 112, height: 84 },
  photo: { width: 112, height: 84, objectFit: 'cover', borderRadius: 3, borderWidth: 1, borderColor: C.border },
  photoStamp: {
    position: 'absolute',
    left: 3,
    bottom: 3,
    fontSize: 5.5,
    color: '#FFFFFF',
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
    paddingHorizontal: 2.5,
    paddingVertical: 1,
    borderRadius: 2,
  },
  photoCaption: { fontSize: 7, fontFamily: 'Helvetica-Bold', marginTop: 2 },
  note: { color: C.muted, fontSize: 8 },
  finding: { flexDirection: 'row', marginTop: 6 },
  findingBar: { width: 3, borderRadius: 2, marginRight: 6 },
  findingTitle: { fontSize: 8.5, fontFamily: 'Helvetica-Bold' },

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
    // Never the page's line height: a re-measured `render` text compounds it
    // on every relayout (see `report-document`'s footer).
    lineHeight: '',
  },
  grow: { flexGrow: 1, flexBasis: 0 },
  spread: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
});

function Chip({ label, tone }: { label: string; tone: ReportTone }) {
  return (
    <Text style={[styles.chip, { color: tone.accent, backgroundColor: tone.surface, borderColor: tone.border }]}>
      {label}
    </Text>
  );
}

function Finding({ finding }: { finding: ComparisonFindingView }) {
  return (
    <View style={styles.finding} wrap={false}>
      <View style={[styles.findingBar, { backgroundColor: finding.tone.accent }]} />
      <View style={styles.grow}>
        <Text style={styles.findingTitle}>
          {finding.title} <Text style={styles.muted}>· {finding.severityLabel}</Text>
        </Text>
        <Text style={{ fontSize: 8 }}>{finding.description}</Text>
      </View>
    </View>
  );
}

function SideColumn({
  side,
  heading,
  images,
  showChecklist,
}: {
  side: ComparisonSideView;
  heading: string;
  images: ReportImages;
  showChecklist: boolean;
}) {
  const photos = side.photos.filter((photo) => images.has(photo.id));
  // Skipped on the day: the reason is the whole record, said once.
  if (side.present && side.skipped && !side.photos.length)
    return (
      <View style={styles.side}>
        <Text style={styles.sideHeading}>{heading.toUpperCase()}</Text>
        <Text style={styles.note}>
          {side.statusLabel}
          {side.skipReason ? `: ${side.skipReason}` : '.'}
        </Text>
      </View>
    );
  return (
    <View style={styles.side}>
      <Text style={styles.sideHeading}>
        {heading.toUpperCase()}
        {side.present && side.renamed ? ` · ${side.name}` : ''}
      </Text>
      {!side.present ? <Text style={styles.note}>{side.statusLabel}.</Text> : null}
      {side.present && side.skipReason ? (
        <Text style={styles.note}>
          {side.statusLabel}: {side.skipReason}
        </Text>
      ) : null}
      {side.present && showChecklist && side.checklist.length ? (
        <View style={styles.table}>
          {side.checklist.map((row) => (
            <Text key={row.id} style={{ fontSize: 7.5 }}>
              {row.label}: {[row.clean && `clean ${row.clean}`, row.undamaged && `undamaged ${row.undamaged}`, row.working && `working ${row.working}`]
                .filter(Boolean)
                .join(', ')}
              {row.comment ? ` — ${row.comment}` : ''}
            </Text>
          ))}
        </View>
      ) : null}
      {photos.length ? (
        <View style={styles.photoGrid}>
          {photos.map((photo) => (
            <View key={photo.id} style={styles.photoCell} wrap={false}>
              <View style={styles.photoFrame}>
                <Image src={images.get(photo.id)!} style={styles.photo} />
                {photo.stamp ? <Text style={styles.photoStamp}>{photo.stamp}</Text> : null}
              </View>
              {photo.caption ? <Text style={styles.photoCaption}>{photo.caption}</Text> : null}
            </View>
          ))}
        </View>
      ) : side.present ? (
        <Text style={styles.note}>No photographs.</Text>
      ) : null}
      {side.findings.map((finding) => (
        <Finding finding={finding} key={finding.id} />
      ))}
    </View>
  );
}

function Room({ room, images }: { room: ComparisonRoomView; images: ReportImages }) {
  return (
    <View style={styles.roomCard} wrap>
      <View style={styles.roomHeader} wrap={false}>
        <View>
          <Text style={styles.roomName}>{room.name}</Text>
          {room.floorName ? <Text style={styles.roomFloor}>{room.floorName}</Text> : null}
        </View>
        <Chip label={room.verdict} tone={room.tone} />
      </View>
      <View style={styles.roomBody}>
        {room.sentence ? <Text style={styles.sentence}>{room.sentence}</Text> : null}
        {room.items.length ? (
          <View style={styles.table}>
            <View style={styles.headRow}>
              <Text style={[styles.headCell, styles.itemCol]}>Item</Text>
              <Text style={[styles.headCell, styles.sideCol]}>At move-in</Text>
              <Text style={[styles.headCell, styles.sideCol]}>At move-out</Text>
              <Text style={[styles.headCell, styles.changeCol]}>Change</Text>
            </View>
            {room.items.map((item) => (
              <View key={item.id} style={styles.row} wrap={false}>
                <Text style={[styles.cell, styles.itemCol, item.quiet ? styles.quiet : {}]}>{item.label}</Text>
                <View style={[styles.cell, styles.sideCol]}>
                  <Text style={item.quiet ? styles.quiet : {}}>{item.moveIn}</Text>
                  {item.moveInComment ? <Text style={styles.comment}>{item.moveInComment}</Text> : null}
                </View>
                <View style={[styles.cell, styles.sideCol]}>
                  <Text style={item.quiet ? styles.quiet : {}}>{item.moveOut}</Text>
                  {item.moveOutComment ? <Text style={styles.comment}>{item.moveOutComment}</Text> : null}
                </View>
                <View style={[styles.cell, styles.changeCol]}>
                  <Text style={[styles.changeText, { color: item.changeTone.accent }]}>{item.change}</Text>
                  {item.cleaning ? (
                    <Text style={[styles.changeText, { color: item.cleaningTone.accent }]}>{item.cleaning}</Text>
                  ) : null}
                </View>
              </View>
            ))}
          </View>
        ) : null}
        <View style={styles.sides}>
          <SideColumn heading="At move-in" images={images} showChecklist={!room.items.length} side={room.moveIn} />
          <SideColumn heading="At move-out" images={images} showChecklist={!room.items.length} side={room.moveOut} />
        </View>
      </View>
    </View>
  );
}

function Footer({ address }: { address: string }) {
  return (
    <View fixed style={styles.footer}>
      <Text>{address}</Text>
      <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
    </View>
  );
}

export function ComparisonPdfDocument({ view, images }: { view: ComparisonView; images: ReportImages }) {
  const address = [view.title, view.subtitle].filter(Boolean).join(' · ');
  return (
    <Document
      author={view.brand.name}
      creator={view.brand.name}
      producer={view.brand.name}
      subject={view.kicker}
      title={`Move-in / move-out comparison — ${view.title}`}
    >
      <Page size="LETTER" style={styles.page}>
        <View style={styles.coverBand}>
          <Text style={styles.coverKicker}>{view.kicker.toUpperCase()}</Text>
          <Text style={styles.coverTitle}>{view.title}</Text>
          {view.subtitle ? <Text style={styles.coverSubtitle}>{view.subtitle}</Text> : null}
          <View style={styles.coverMetaRow}>
            {(
              [
                ['MOVE-IN', view.moveIn],
                ['MOVE-OUT', view.moveOut],
              ] as const
            ).map(([label, side]) => (
              <View key={label}>
                <Text style={styles.coverMetaLabel}>{label}</Text>
                <Text style={styles.coverMetaValue}>{side.label}</Text>
                <Text style={styles.coverMetaSub}>{side.date}</Text>
                {side.inspector ? <Text style={styles.coverMetaSub}>Inspector: {side.inspector}</Text> : null}
              </View>
            ))}
          </View>
        </View>

        <Text style={styles.sectionTitle}>At a glance</Text>
        <View style={styles.rule} />
        <View style={styles.statRow}>
          {view.stats.map((stat) => (
            <View key={stat.label} style={styles.statCard}>
              <Text style={[styles.statValue, { color: stat.tone.accent }]}>{stat.value}</Text>
              <Text style={styles.statLabel}>{stat.label}</Text>
            </View>
          ))}
        </View>

        <Text style={styles.sectionTitle}>Summary</Text>
        <Text style={styles.sectionHint}>{view.headline}.</Text>
        {view.newDamage.length ? (
          <View>
            <Text style={styles.summaryHeading}>NEW SINCE MOVE-IN</Text>
            {view.newDamage.map((room) => (
              <Text key={room.id} style={styles.summaryLine}>
                <Text style={styles.bold}>{room.name}</Text>
                {room.items.length ? <Text style={styles.muted}> — {comparisonItemList(room.items)}</Text> : null}
              </Text>
            ))}
          </View>
        ) : null}
        {view.cleaning.length ? (
          <View>
            <Text style={styles.summaryHeading}>NEEDS CLEANING</Text>
            {view.cleaning.map((room) => (
              <Text key={room.id} style={styles.summaryLine}>
                <Text style={styles.bold}>{room.name}</Text>
                <Text style={styles.muted}> — {comparisonItemList(room.items)}</Text>
              </Text>
            ))}
          </View>
        ) : null}

        <Footer address={address} />
      </Page>

      <Page size="LETTER" style={styles.page}>
        <Text style={styles.sectionTitle}>Room by room</Text>
        <Text style={styles.sectionHint}>
          Each room as the move-in and the move-out inspections recorded it, item by item, with the
          photographs from both.
        </Text>
        {view.rooms.map((room) => (
          <Room images={images} key={room.id} room={room} />
        ))}

        <View style={styles.disclaimer} wrap={false}>
          <Text>{view.disclaimer}</Text>
        </View>
        <Text style={styles.brandLine}>
          {[view.brand.name, view.brand.addressLine1, view.brand.addressLine2, view.brand.phone, view.brand.email]
            .filter(Boolean)
            .join(' · ')}
        </Text>
        <Text style={[styles.brandLine, { marginTop: 2 }]}>Generated {view.generatedLabel}</Text>

        <Footer address={address} />
      </Page>
    </Document>
  );
}
