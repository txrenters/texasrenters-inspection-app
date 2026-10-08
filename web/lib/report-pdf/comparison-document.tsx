/**
 * The PDF of a move-in / move-out comparison, for the owner or tenant a link
 * was sent to.
 *
 * Presentation only, as for the inspection report's PDF (`report-document`):
 * what appears and in what words is the shared `ComparisonView`, which the web
 * page renders too. Content logic added here would silently diverge from it.
 *
 * The page's order (2026-10-09): what was found, the key to the four signs,
 * the rooms at a glance; then each room with only what changed and its first
 * photographs; then the rooms the two inspections do not share; then the rest
 * of the photographs, so the reading part stays short.
 */
import { Circle, Document, Image, Page, Path, StyleSheet, Svg, Text, View } from '@react-pdf/renderer';
import { COMPARISON_MARK_TONE, REPORT_PALETTE } from '@texasrenters/shared';
import type {
  ComparisonChecklistRowView,
  ComparisonFindingView,
  ComparisonMark,
  ComparisonMarkKind,
  ComparisonRoomView,
  ComparisonSideView,
  ComparisonView,
  ReportPhotoView,
  ReportTone,
} from '@texasrenters/shared';

import type { ReportImages } from './report-document';

const C = REPORT_PALETTE;

/** Photographs printed with each side of a room; the rest go to the pages at the end. */
export const PDF_INLINE_PHOTOS = 3;

export interface PdfPhotoGroup {
  key: string;
  title: string;
  photos: ReportPhotoView[];
}

/**
 * Which photographs the PDF prints where: the first few of each side in the
 * room, the rest grouped at the end. The loader fetches them in this order, so
 * a cap on the work drops the end pages' photographs, never a room's own.
 */
export function comparisonPdfPhotos(view: ComparisonView) {
  const inline = view.rooms.flatMap((room) => [
    ...room.moveIn.photos.slice(0, PDF_INLINE_PHOTOS),
    ...room.moveOut.photos.slice(0, PDF_INLINE_PHOTOS),
  ]);
  const later: PdfPhotoGroup[] = [
    ...view.rooms.flatMap((room) => [
      { key: `${room.id}-in`, title: `${room.name}, move-in`, photos: room.moveIn.photos.slice(PDF_INLINE_PHOTOS) },
      { key: `${room.id}-out`, title: `${room.name}, move-out`, photos: room.moveOut.photos.slice(PDF_INLINE_PHOTOS) },
    ]),
    ...view.uncompared.map((room) => ({
      key: `${room.id}-only`,
      title: `${room.name}, ${room.recordedAt.toLowerCase()}`,
      photos: room.side.photos,
    })),
  ].filter((group) => group.photos.length);
  return { inline, later };
}

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
    marginBottom: 22,
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

  found: { borderWidth: 1.5, borderColor: C.text, borderRadius: 6, padding: 14, marginBottom: 12 },
  foundTitle: { fontSize: 13, fontFamily: 'Helvetica-Bold', marginBottom: 8 },
  foundLine: { flexDirection: 'row', gap: 7, marginTop: 4 },
  foundText: { fontSize: 10.5, flexGrow: 1, flexBasis: 0 },
  key: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 12,
    backgroundColor: C.surfaceSubtle,
    borderRadius: 5,
    paddingVertical: 6,
    paddingHorizontal: 10,
    marginBottom: 18,
  },

  sectionTitle: { fontSize: 13, fontFamily: 'Helvetica-Bold', marginBottom: 3 },
  sectionHint: { color: C.muted, marginBottom: 10 },
  bold: { fontFamily: 'Helvetica-Bold' },
  muted: { color: C.muted },

  indexRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingVertical: 4,
    borderBottomWidth: 0.5,
    borderBottomColor: C.border,
  },
  indexName: { fontFamily: 'Helvetica-Bold', flexGrow: 1, flexBasis: 0 },
  indexDigest: { color: C.muted },

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
    paddingVertical: 9,
    paddingHorizontal: 12,
    backgroundColor: C.surfaceSubtle,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  roomName: { fontSize: 12, fontFamily: 'Helvetica-Bold' },
  roomNote: { color: C.muted, fontSize: 8, marginTop: 1 },
  roomBody: { padding: 12 },
  sentence: { marginTop: 5 },

  // The item table: three columns that line up down the page.
  table: { marginBottom: 8 },
  headRow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: C.text },
  row: { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: C.border },
  headCell: { fontSize: 7.5, color: C.muted, fontFamily: 'Helvetica-Bold', paddingVertical: 3, paddingHorizontal: 4 },
  cell: { paddingVertical: 4, paddingHorizontal: 4 },
  itemCol: { width: '36%' },
  inCol: { width: '28%' },
  outCol: { width: '36%' },
  itemLabel: { fontFamily: 'Helvetica-Bold', fontSize: 9 },
  result: { fontSize: 7.5, fontFamily: 'Helvetica-Bold', marginTop: 1 },
  comment: { color: C.muted, fontSize: 7, fontStyle: 'italic', marginTop: 1 },
  marks: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  mark: { flexDirection: 'row', alignItems: 'center', gap: 2.5 },
  markText: { fontSize: 8.5, fontFamily: 'Helvetica-Bold' },
  folded: { color: C.muted, fontSize: 8.5, marginBottom: 8 },

  subHeading: {
    color: C.muted,
    fontSize: 7.5,
    letterSpacing: 1,
    fontFamily: 'Helvetica-Bold',
    marginTop: 4,
    marginBottom: 4,
  },
  note: { flexDirection: 'row', justifyContent: 'space-between', gap: 8, paddingVertical: 3, borderBottomWidth: 0.5, borderBottomColor: C.border },
  noteTitle: { fontSize: 8.5, fontFamily: 'Helvetica-Bold' },
  noteText: { fontSize: 7.5, color: C.muted },
  noteSeverity: { fontSize: 7.5, color: C.muted },

  recordedRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 6, paddingVertical: 2, borderBottomWidth: 0.5, borderBottomColor: C.border },

  sides: { flexDirection: 'row', gap: 12, marginTop: 8 },
  side: { flexGrow: 1, flexBasis: 0 },
  sideHeading: { fontSize: 8, fontFamily: 'Helvetica-Bold', marginBottom: 4 },
  photoGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
  photoFrame: { position: 'relative', width: 74, height: 56 },
  photo: { width: 74, height: 56, objectFit: 'cover', borderRadius: 3, borderWidth: 0.5, borderColor: C.border },
  largeFrame: { position: 'relative', width: 104, height: 78 },
  largePhoto: { width: 104, height: 78, objectFit: 'cover', borderRadius: 3, borderWidth: 0.5, borderColor: C.border },
  photoStamp: {
    position: 'absolute',
    left: 2,
    bottom: 2,
    fontSize: 5,
    color: '#FFFFFF',
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
    paddingHorizontal: 2,
    paddingVertical: 0.5,
    borderRadius: 2,
  },
  photoCaption: { fontSize: 6.5, marginTop: 1.5, width: 104 },
  more: { color: C.muted, fontSize: 7.5, marginTop: 3 },

  uncomparedRow: { flexDirection: 'row', paddingVertical: 4, borderBottomWidth: 0.5, borderBottomColor: C.border, gap: 6 },

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
  spread: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 },
});

function Chip({ label, tone }: { label: string; tone: ReportTone }) {
  return (
    <Text style={[styles.chip, { color: tone.accent, backgroundColor: tone.surface, borderColor: tone.border }]}>
      {label}
    </Text>
  );
}

/** The sign: a tinted disc with a tick, a cross, a half-fill or a dash -- the web page's own. */
function Glyph({ kind, size = 9 }: { kind: ComparisonMarkKind; size?: number }) {
  const color = COMPARISON_MARK_TONE[kind].accent;
  const line = { stroke: color, strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' };
  return (
    <Svg height={size} viewBox="0 0 16 16" width={size}>
      <Circle cx="8" cy="8" fill={color} fillOpacity={0.16} r="7.25" />
      {kind === 'good' ? <Path d="M4.8 8.4l2.1 2.1 4.3-4.7" {...line} /> : null}
      {kind === 'damaged' ? <Path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" {...line} /> : null}
      {kind === 'dirty' ? <Circle cx="8" cy="8" fill="none" r="4.2" stroke={color} strokeWidth={1.6} /> : null}
      {kind === 'dirty' ? <Path d="M8 3.8a4.2 4.2 0 0 1 0 8.4z" fill={color} /> : null}
      {kind === 'none' ? <Path d="M5.2 8h5.6" {...line} /> : null}
    </Svg>
  );
}

function Mark({ mark }: { mark: ComparisonMark }) {
  return (
    <View style={styles.mark}>
      <Glyph kind={mark.kind} />
      <Text
        style={[
          styles.markText,
          { color: COMPARISON_MARK_TONE[mark.kind].accent },
          mark.kind === 'none' ? { fontFamily: 'Helvetica' } : {},
        ]}
      >
        {mark.label}
      </Text>
    </View>
  );
}

function Marks({ marks, comment }: { marks: ComparisonMark[]; comment?: string | null }) {
  return (
    <View>
      <View style={styles.marks}>
        {marks.map((mark) => (
          <Mark key={`${mark.kind}-${mark.label}`} mark={mark} />
        ))}
      </View>
      {comment ? <Text style={styles.comment}>{comment}</Text> : null}
    </View>
  );
}

function Notes({ heading, findings }: { heading: string; findings: ComparisonFindingView[] }) {
  if (!findings.length) return null;
  return (
    <View>
      <Text style={styles.subHeading}>{heading.toUpperCase()}</Text>
      {findings.map((finding) => (
        <View key={finding.id} style={styles.note} wrap={false}>
          <View style={styles.grow}>
            <Text style={styles.noteTitle}>{finding.title}</Text>
            {finding.description ? <Text style={styles.noteText}>{finding.description}</Text> : null}
          </View>
          <Text style={styles.noteSeverity}>{finding.severityLabel}</Text>
        </View>
      ))}
    </View>
  );
}

function Recorded({ heading, rows }: { heading: string; rows: ComparisonChecklistRowView[] }) {
  return (
    <View style={styles.side}>
      <Text style={styles.sideHeading}>{heading}</Text>
      {rows.length ? (
        rows.map((row) => (
          <View key={row.id} style={styles.recordedRow} wrap={false}>
            <Text style={[styles.bold, { fontSize: 8.5 }]}>{row.label}</Text>
            <Marks comment={row.comment} marks={row.marks} />
          </View>
        ))
      ) : (
        <Text style={styles.muted}>Nothing graded.</Text>
      )}
    </View>
  );
}

function SidePhotos({
  side,
  heading,
  images,
}: {
  side: ComparisonSideView;
  heading: string;
  images: ReportImages;
}) {
  const photos = side.photos.slice(0, PDF_INLINE_PHOTOS).filter((photo) => images.has(photo.id));
  const rest = side.photos.length - PDF_INLINE_PHOTOS;
  return (
    <View style={styles.side}>
      <Text style={styles.sideHeading}>
        {heading} <Text style={styles.muted}>({side.photos.length})</Text>
      </Text>
      {photos.length ? (
        <View style={styles.photoGrid}>
          {photos.map((photo) => (
            <View key={photo.id} style={styles.photoFrame} wrap={false}>
              <Image src={images.get(photo.id)!} style={styles.photo} />
              {photo.stamp ? <Text style={styles.photoStamp}>{photo.stamp}</Text> : null}
            </View>
          ))}
        </View>
      ) : (
        <Text style={styles.more}>{side.photos.length ? 'Photographs on the online report.' : 'No photographs.'}</Text>
      )}
      {rest > 0 ? <Text style={styles.more}>{rest} more at the end of this report.</Text> : null}
    </View>
  );
}

function Room({ room, images }: { room: ComparisonRoomView; images: ReportImages }) {
  const changed = room.items.filter((item) => item.changed);
  const recorded =
    !room.items.length && (room.moveIn.checklist.length > 0 || room.moveOut.checklist.length > 0);
  return (
    <View style={styles.roomCard} wrap>
      <View style={styles.roomHeader} wrap={false}>
        <View style={styles.spread}>
          <View style={styles.grow}>
            <Text style={styles.roomName}>{room.name}</Text>
            {room.floorName ? <Text style={styles.roomNote}>{room.floorName}</Text> : null}
            {room.moveIn.present && room.moveIn.renamed ? (
              <Text style={styles.roomNote}>Compared with the move-in&apos;s &ldquo;{room.moveIn.name}&rdquo;</Text>
            ) : null}
          </View>
          <Chip label={room.verdict} tone={room.tone} />
        </View>
        {room.sentence ? <Text style={styles.sentence}>{room.sentence}</Text> : null}
      </View>
      <View style={styles.roomBody}>
        {changed.length ? (
          <View style={styles.table}>
            <View style={styles.headRow}>
              <Text style={[styles.headCell, styles.itemCol]}>Item</Text>
              <Text style={[styles.headCell, styles.inCol]}>Move-in</Text>
              <Text style={[styles.headCell, styles.outCol]}>Move-out</Text>
            </View>
            {changed.map((item) => (
              <View key={item.id} style={styles.row} wrap={false}>
                <View style={[styles.cell, styles.itemCol]}>
                  <Text style={styles.itemLabel}>{item.label}</Text>
                  {item.result ? (
                    <Text style={[styles.result, { color: item.result.tone.accent }]}>{item.result.label}</Text>
                  ) : item.needsCleaning ? (
                    <Text style={[styles.result, { color: COMPARISON_MARK_TONE.dirty.accent }]}>Needs cleaning</Text>
                  ) : null}
                </View>
                <View style={[styles.cell, styles.inCol]}>
                  <Marks comment={item.moveIn.comment} marks={item.moveIn.marks} />
                </View>
                <View style={[styles.cell, styles.outCol]}>
                  <Marks comment={item.moveOut.comment} marks={item.moveOut.marks} />
                </View>
              </View>
            ))}
          </View>
        ) : null}
        {room.folded ? (
          <Text style={styles.folded}>
            {changed.length ? 'Also checked: ' : ''}
            {room.folded}
          </Text>
        ) : null}
        {recorded ? (
          <View style={[styles.sides, { marginTop: 0, marginBottom: 6 }]}>
            <Recorded heading="Recorded at move-in" rows={room.moveIn.checklist} />
            <Recorded heading="Recorded at move-out" rows={room.moveOut.checklist} />
          </View>
        ) : null}
        <Notes findings={room.moveOut.findings} heading="Noted at move-out, confirmed by our team" />
        <Notes findings={room.moveIn.findings} heading="Noted at move-in" />
        {/* Kept whole: a heading never ends a page with its photographs on the next. */}
        <View style={styles.sides} wrap={false}>
          <SidePhotos heading="Move-in photos" images={images} side={room.moveIn} />
          <SidePhotos heading="Move-out photos" images={images} side={room.moveOut} />
        </View>
      </View>
    </View>
  );
}

/** How the report was drawn, and who sent it: the last lines. */
function Closing({ view }: { view: ComparisonView }) {
  return (
    <View wrap={false}>
      <View style={styles.disclaimer}>
        <Text>{view.disclaimer}</Text>
      </View>
      <Text style={styles.brandLine}>
        {[view.brand.name, view.brand.addressLine1, view.brand.addressLine2, view.brand.phone, view.brand.email]
          .filter(Boolean)
          .join(' · ')}
      </Text>
      <Text style={[styles.brandLine, { marginTop: 2 }]}>Generated {view.generatedLabel}</Text>
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
  const { later } = comparisonPdfPhotos(view);
  const laterShown = later
    .map((group) => ({ ...group, photos: group.photos.filter((photo) => images.has(photo.id)) }))
    .filter((group) => group.photos.length);
  const laterMissing =
    later.reduce((total, group) => total + group.photos.length, 0) -
    laterShown.reduce((total, group) => total + group.photos.length, 0);
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
                ['MOVE-IN INSPECTION', view.moveIn],
                ['MOVE-OUT INSPECTION', view.moveOut],
              ] as const
            ).map(([label, side]) => (
              <View key={label}>
                <Text style={styles.coverMetaLabel}>{label}</Text>
                <Text style={styles.coverMetaValue}>{side.date}</Text>
                <Text style={styles.coverMetaSub}>{side.label}</Text>
                {side.inspector ? <Text style={styles.coverMetaSub}>Inspector: {side.inspector}</Text> : null}
              </View>
            ))}
          </View>
        </View>

        <View style={styles.found} wrap={false}>
          <Text style={styles.foundTitle}>What we found</Text>
          {view.found.map((line) => (
            <View key={line.lead} style={styles.foundLine}>
              <Glyph kind={line.mark} size={12} />
              <Text style={styles.foundText}>
                <Text style={styles.bold}>{line.lead}</Text> {line.detail}
              </Text>
            </View>
          ))}
        </View>

        <View style={styles.key} wrap={false}>
          <Text style={styles.bold}>How to read this report:</Text>
          {view.key.map((mark) => (
            <Mark key={mark.kind} mark={mark} />
          ))}
        </View>

        {view.rooms.length ? (
          <View>
            <Text style={styles.sectionTitle}>Room by room</Text>
            {view.rooms.map((room) => (
              <View key={room.id} style={styles.indexRow} wrap={false}>
                <Glyph kind={room.mark} size={10} />
                <Text style={styles.indexName}>{room.name}</Text>
                <Text style={styles.indexDigest}>{room.digest}</Text>
              </View>
            ))}
          </View>
        ) : null}

        <Footer address={address} />
      </Page>

      <Page size="LETTER" style={styles.page}>
        {view.rooms.map((room) => (
          <Room images={images} key={room.id} room={room} />
        ))}
        {view.uncompared.length ? (
          <View style={{ marginTop: view.rooms.length ? 8 : 0 }}>
            <Text minPresenceAhead={90} style={styles.sectionTitle}>
              Rooms we couldn&apos;t compare
            </Text>
            <Text style={styles.sectionHint}>
              These rooms were recorded at only one of the two inspections, so there is nothing to compare them
              with. What that inspection recorded is shown for reference.
            </Text>
            {view.uncompared.map((room) => (
              <View key={room.id} style={styles.uncomparedRow} wrap={false}>
                <View style={{ width: '32%' }}>
                  <Text style={styles.bold}>{room.name}</Text>
                  <Text style={[styles.muted, { fontSize: 8 }]}>{room.reason}</Text>
                </View>
                <View style={[styles.grow, styles.mark]}>
                  <Glyph kind={room.mark} />
                  <Text>
                    {room.recordedAt}: {room.recorded}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        ) : null}
        {laterShown.length ? null : <Closing view={view} />}
        <Footer address={address} />
      </Page>

      {laterShown.length ? (
        <Page size="LETTER" style={styles.page}>
          <View>
            <Text style={styles.sectionTitle}>More photographs</Text>
            <Text style={styles.sectionHint}>
              The rest of each room&apos;s photographs, room by room.
              {laterMissing ? ` ${laterMissing} more are on the online report.` : ''}
            </Text>
            {laterShown.map((group) => (
              <View key={group.key} style={{ marginBottom: 10 }}>
                <Text style={styles.sideHeading} minPresenceAhead={110}>
                  {group.title}
                </Text>
                <View style={styles.photoGrid}>
                  {group.photos.map((photo) => (
                    <View key={photo.id} wrap={false}>
                      <View style={styles.largeFrame}>
                        <Image src={images.get(photo.id)!} style={styles.largePhoto} />
                        {photo.stamp ? <Text style={styles.photoStamp}>{photo.stamp}</Text> : null}
                      </View>
                      {photo.caption ? <Text style={styles.photoCaption}>{photo.caption}</Text> : null}
                    </View>
                  ))}
                </View>
              </View>
            ))}
          </View>
          <Closing view={view} />
          <Footer address={address} />
        </Page>
      ) : null}
    </Document>
  );
}
