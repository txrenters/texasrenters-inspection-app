/**
 * The PDF rendering of an inspection report.
 *
 * This file owns presentation only. Every decision about *what* appears, in
 * what order, and how it is worded comes from the shared `ReportView`, which
 * the public web page renders too — see shared/src/report/report-view.ts. Keep
 * it that way: content logic added here silently diverges from the web report.
 */
import { Document, Image, Page, StyleSheet, Text, View } from '@react-pdf/renderer';
import { NARRATION_HEADING, REPORT_PALETTE } from '@texasrenters/shared';
import type { ReportActionGroupView, ReportRoomView, ReportView } from '@texasrenters/shared';

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
  /**
   * Caps, matching the office's report, which sets area and item names that
   * way — "BATHROOM", "DOORS & LOCKS".
   *
   * `textTransform` rather than uppercasing the string: the shared view model
   * owns the content and both renderers only style it, so the casing decision
   * has to live in the stylesheet or the web page and the PDF would each need
   * their own copy of it. Letter-spacing comes with it, because caps set at
   * these sizes without tracking are noticeably harder to read.
   */
  roomName: {
    fontSize: 11,
    fontFamily: 'Helvetica-Bold',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  roomFloor: { color: C.muted, fontSize: 8.5, marginTop: 1 },
  roomBody: { padding: 12 },

  photoGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  // Three a row, filling it: the room body is 498 pt wide, less two 8 pt gaps
  // (2026-10-08: bigger photographs). 4:3, as the cameras shoot.
  photoCell: { width: 160 },
  photo: {
    width: 160,
    height: 120,
    objectFit: 'cover',
    borderRadius: 4,
    borderWidth: 1,
    borderColor: C.border,
  },
  photoFrame: { position: 'relative', width: 160, height: 120 },
  photoCaption: { fontSize: 7.5, fontFamily: 'Helvetica-Bold', marginTop: 3 },
  // On the photograph, bottom left, as the office's timestamp-camera reports
  // print it -- inside the frame, so the crop to fill the cell never cuts it.
  photoStamp: {
    position: 'absolute',
    left: 4,
    bottom: 4,
    fontSize: 6,
    color: '#FFFFFF',
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
    paddingHorizontal: 3,
    paddingVertical: 1.5,
    borderRadius: 2,
  },

  // What the room needs, under its photographs (2026-10-07).
  narration: { marginTop: 10, paddingTop: 8, borderTopWidth: 1, borderTopColor: C.border },
  narrationHeading: { fontSize: 9.5, fontFamily: 'Helvetica-Bold', marginBottom: 3 },
  // Two columns (2026-10-08: "so it's not that long").
  actionColumns: { flexDirection: 'row', gap: 16 },
  actionColumn: { flexGrow: 1, flexBasis: 0 },
  actionHeading: { fontSize: 9, fontFamily: 'Helvetica-Bold', marginTop: 4, marginBottom: 2 },
  actionItem: { flexDirection: 'row', fontSize: 8.5, marginBottom: 1.5 },
  actionMark: { width: 10 },
  actionText: { flexGrow: 1, flexBasis: 0 },
  emptyRoom: { color: C.muted, fontSize: 8.5 },
  // The condition table. Column widths are fixed rather than proportional so
  // the three verdict columns line up down the page the way the office's
  // printed reports do.
  checklistTable: { marginBottom: 8 },
  checklistRow: { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: C.border },
  checklistHeadRow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: C.border },
  checklistHeadCell: { fontSize: 7, color: C.muted, paddingVertical: 3, paddingHorizontal: 4 },
  checklistCell: { fontSize: 8, paddingVertical: 3, paddingHorizontal: 4 },
  checklistLabel: {
    width: '32%',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    fontSize: 7.5,
  },
  checklistAxis: { width: '11%', textAlign: 'center' },
  // One answer where the three verdicts would be: the width of all three, so
  // the Comments column still lines up with the rows above and below it.
  checklistAnswer: { width: '33%', textAlign: 'center', fontWeight: 700 },
  checklistPass: { color: C.pass, fontWeight: 700 },
  checklistFail: { color: C.fail, fontWeight: 700 },
  checklistComment: { width: '35%', color: C.muted },
  quietRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 5,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  quietName: { textTransform: 'uppercase', letterSpacing: 0.5, fontFamily: 'Helvetica-Bold' },

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
    /**
     * Never the page's line height.
     *
     * @react-pdf re-resolves a node's style on every relayout, and treats an
     * already-resolved line height as unitless again, so it multiplies by the
     * font size once more each pass. Ordinary text keeps its measured lines;
     * this footer's page number is a `render` text, re-measured every time, so
     * the inherited `lineHeight: 1.5` grew roughly 7.5-fold per pass. It was
     * off the page from page one, which is why no PDF ever showed "Page N of
     * M", and past pdfkit's 1e21 limit by page eleven: every report that long
     * failed to download with `unsupported number: -1.9064433873226668e+21`.
     * Upstream: diegomura/react-pdf#2988 and #3277, both open.
     *
     * An empty string is the stylesheet's "unset" -- text falls back to the
     * font's own line height. A number or a point value here still grows.
     */
    lineHeight: '',
  },

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

/**
 * The condition table, printed before the photographs.
 *
 * An unassessed axis renders as an empty cell rather than "N" — the view model
 * already made that decision, so this renderer and the HTML page cannot
 * disagree about what a blank means.
 */
/**
 * Returns an empty style rather than undefined: @react-pdf's array form rejects
 * an undefined entry, so an unassessed cell would crash the render.
 */
function axisTone(value: string) {
  if (value === 'Y') return styles.checklistPass;
  if (value === 'N') return styles.checklistFail;
  return {};
}

function ChecklistTable({ room }: { room: ReportRoomView }) {
  if (!room.checklist.length) return null;
  // An occupied room answers each question once. Heading it with three verdict
  // columns it never fills is what made its answers look missing.
  const answersOnly = room.checklist.every((row) => row.kind === 'ANSWER');
  return (
    <View style={styles.checklistTable}>
      <View style={styles.checklistHeadRow}>
        <Text style={[styles.checklistHeadCell, styles.checklistLabel]}>Room / item</Text>
        {answersOnly ? (
          <Text style={[styles.checklistHeadCell, styles.checklistAnswer]}>Condition</Text>
        ) : (
          <>
            <Text style={[styles.checklistHeadCell, styles.checklistAxis]}>Clean</Text>
            <Text style={[styles.checklistHeadCell, styles.checklistAxis]}>Undam.</Text>
            <Text style={[styles.checklistHeadCell, styles.checklistAxis]}>Working</Text>
          </>
        )}
        <Text style={[styles.checklistHeadCell, styles.checklistComment]}>Comments</Text>
      </View>
      {room.checklist.map((row) => (
        // Wrappable. A row whose comment borrows two findings can run longer
        // than the space left on the page, and `wrap={false}` there does not
        // move it — it clips it, losing the explanation the column exists for.
        <View key={row.id} style={styles.checklistRow}>
          <Text style={[styles.checklistCell, styles.checklistLabel]}>{row.label}</Text>
          {row.kind === 'ANSWER' ? (
            <Text style={[styles.checklistCell, styles.checklistAnswer]}>{row.answer}</Text>
          ) : (
            <>
              {/* Colour is an accent on the letter, never a substitute for it —
                  the table has to survive a monochrome print. */}
              <Text style={[styles.checklistCell, styles.checklistAxis, axisTone(row.clean)]}>
                {row.clean}
              </Text>
              <Text style={[styles.checklistCell, styles.checklistAxis, axisTone(row.undamaged)]}>
                {row.undamaged}
              </Text>
              <Text style={[styles.checklistCell, styles.checklistAxis, axisTone(row.working)]}>
                {row.working}
              </Text>
            </>
          )}
          <Text style={[styles.checklistCell, styles.checklistComment]}>{row.comment}</Text>
        </View>
      ))}
    </View>
  );
}

/** Characters to a line of a half-width column at the bullets' size, near enough. */
const ACTION_COLUMN_CHARS = 50;

type ActionColumn = Array<ReportActionGroupView & { continued: boolean }>;

/**
 * The room's bullets split into two columns of about equal height.
 *
 * @react-pdf has no CSS columns, so the split is made here: each bullet is
 * weighed by the lines it will take (its places beneath it included, and its
 * group's heading when it opens one), and the cut falls where the two halves
 * are closest. A bullet is never split. A group cut in two repeats its
 * heading, marked "(continued)", at the top of the right-hand column. Layout
 * only: what is listed, and in what order, is the view model's.
 */
export function actionColumns(groups: ReportActionGroupView[]): [ActionColumn, ActionColumn] {
  const lines = (text: string) => Math.max(1, Math.ceil(text.length / ACTION_COLUMN_CHARS));
  const entries = groups.flatMap((group, groupIndex) =>
    group.items.map((item, index) => ({
      groupIndex,
      item,
      weight:
        lines(item.text) +
        item.details.reduce((total, detail) => total + lines(detail), 0) +
        (index === 0 ? 1.5 : 0),
    })),
  );
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
  let cut = entries.length;
  let best = Number.POSITIVE_INFINITY;
  let running = 0;
  // Never an empty left column; an empty right one only when there is one bullet.
  for (let index = 1; index <= entries.length; index += 1) {
    running += entries[index - 1].weight;
    const gap = Math.abs(total - 2 * running);
    if (gap < best) {
      best = gap;
      cut = index;
    }
  }
  const column = (part: typeof entries, startsMidGroup: boolean): ActionColumn => {
    const result: ActionColumn = [];
    for (const entry of part) {
      const last = result[result.length - 1];
      if (last && last.heading === groups[entry.groupIndex].heading) last.items.push(entry.item);
      else
        result.push({
          heading: groups[entry.groupIndex].heading,
          continued: startsMidGroup && result.length === 0,
          items: [entry.item],
        });
    }
    return result;
  };
  const left = entries.slice(0, cut);
  const right = entries.slice(cut);
  const midGroup = left.length > 0 && right.length > 0 && left[left.length - 1].groupIndex === right[0].groupIndex;
  return [column(left, false), column(right, midGroup)];
}

function Room({ room, images }: { room: ReportRoomView; images: ReportImages }) {
  const photos = room.photos.filter((photo) => images.has(photo.id));
  return (
    // Small rooms stay whole on one page; large ones are allowed to split
    // rather than leaving most of a page blank.
    <View
      style={styles.roomCard}
      wrap={room.checklist.length + photos.length + room.actions.length > 4}
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
                <View style={styles.photoFrame}>
                  <Image style={styles.photo} src={images.get(photo.id)!} />
                  {photo.stamp ? <Text style={styles.photoStamp}>{photo.stamp}</Text> : null}
                </View>
                {photo.caption ? <Text style={styles.photoCaption}>{photo.caption}</Text> : null}
              </View>
            ))}
          </View>
        ) : null}
        {/* What the room needs, from the summary of its recordings. The
            timestamped points are not printed (the maintenance team,
            2026-10-07). Wrappable: a long list has to be allowed across a
            page break rather than clipped. */}
        {room.actions.length ? (
          <View style={styles.narration}>
            <Text style={styles.narrationHeading}>{NARRATION_HEADING}:</Text>
            {/* Two balanced columns under the office's headings. A bullet
                and an en dash: both are in the PDF's standard font, where a
                hollow circle is not. */}
            <View style={styles.actionColumns}>
              {actionColumns(room.actions).map((column, columnIndex) => (
                <View key={columnIndex} style={styles.actionColumn}>
                  {column.map((group) => (
                    <View key={group.heading}>
                      <Text style={styles.actionHeading}>
                        {group.continued ? `${group.heading} (continued)` : group.heading}
                      </Text>
                      {group.items.map((item, index) => (
                        <View key={index} wrap={false}>
                          <View style={styles.actionItem}>
                            <Text style={styles.actionMark}>{'•'}</Text>
                            <Text style={styles.actionText}>{item.text}</Text>
                          </View>
                          {item.details.map((detail, detailIndex) => (
                            <View key={detailIndex} style={[styles.actionItem, { paddingLeft: 10 }]}>
                              <Text style={styles.actionMark}>{'–'}</Text>
                              <Text style={styles.actionText}>{detail}</Text>
                            </View>
                          ))}
                        </View>
                      ))}
                    </View>
                  ))}
                </View>
              ))}
            </View>
          </View>
        ) : null}
        {!room.checklist.length && !photos.length && !room.actions.length ? (
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
            {/* The one count the report keeps. The "At a glance" counters and
                the summary of findings that used to fill the first page are
                gone with the findings lists they counted (2026-10-07), so
                the rooms start on the cover page. */}
            <View>
              <Text style={styles.coverMetaLabel}>ROOMS INSPECTED</Text>
              <Text style={styles.coverMetaValue}>
                {view.summary.roomsInspected} of {view.summary.roomsTotal}
              </Text>
            </View>
          </View>
        </View>

        <Text style={styles.sectionTitle}>Room by room</Text>
        <Text style={styles.sectionHint}>
          The condition table, photographs and walkthrough recording for each area of the property.
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
                {/* Nested rather than transforming the whole line: only the
                    area name is set in caps, not its floor or the reason it
                    was skipped. */}
                <Text>
                  <Text style={styles.quietName}>{room.name}</Text>
                  {room.floorName ? ` · ${room.floorName}` : ''}
                  {room.skipReason ? ` — ${room.skipReason}` : ''}
                </Text>
                <Text style={{ color: C.muted }}>{room.statusLabel}</Text>
              </View>
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
