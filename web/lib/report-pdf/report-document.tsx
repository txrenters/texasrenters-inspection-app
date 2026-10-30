/**
 * The PDF rendering of an inspection report.
 *
 * This file owns presentation only. Every decision about *what* appears, in
 * what order, and how it is worded comes from the shared `ReportView`, which
 * the public web page renders too — see shared/src/report/report-view.ts. Keep
 * it that way: content logic added here silently diverges from the web report.
 */
import { Document, Font, Image, Page, StyleSheet, Text, View } from '@react-pdf/renderer';
import { REPORT_PALETTE, REPORT_TYPE } from '@texasrenters/shared';
import type { ReportRoomView, ReportView } from '@texasrenters/shared';
import { Fragment } from 'react';

/**
 * Words wrap whole, never broken with a hyphen. At 13.5 pt (2026-10-08) the
 * library's default split a room's items mid-word -- "WALLS AND CEIL- INGS" --
 * where moving the word to the next line was what a reader expects. Set once,
 * for every document this process renders.
 */
Font.registerHyphenationCallback((word) => [word]);

const C = REPORT_PALETTE;
/**
 * Running text, in points: 12 (the office, 2026-10-28, down from 13.5). Every
 * other size here is set from it -- headings above, small labels below -- so
 * the PDF and the web report change together. Helvetica is the PDF's own
 * Arial; see `REPORT_TYPE`.
 */
const B = REPORT_TYPE.bodyPt;
/** The condition table's lines (2026-10-08: drawn round every cell, as InspectCloud's are). */
const GRID = 0.75;
/**
 * Tall enough for "Undamaged", slanted at 50 degrees: the word is about 5.5
 * lines long, so its rise plus its own line and lift fits in 5.5 lines. 74 pt
 * at 13.5, and it shrinks with the type rather than leaving a gap above.
 */
const AXIS_HEAD_HEIGHT = Math.round(B * 5.5);
/** The verdict headings' slant (the maintenance team, 2026-10-09: "around 50 degrees"). */
const AXIS_HEAD_SLANT = 50;
const SLANT_SIN = Math.sin((AXIS_HEAD_SLANT * Math.PI) / 180);
const SLANT_COS = Math.cos((AXIS_HEAD_SLANT * Math.PI) / 180);
/** How far a heading is lifted off the bottom of its row. */
const AXIS_HEAD_LIFT = 4;
/**
 * Where a heading's bottom-left corner sits, right of its column's middle, so
 * the name -- one line of running text -- is centred between the two slanted lines
 * a column apart: (half the line + its lift x cos) / sin.
 */
const AXIS_HEAD_OFFSET = (B / 2 + AXIS_HEAD_LIFT * SLANT_COS) / SLANT_SIN;

/** The space between two rooms. */
const ROOM_GAP = 14;
/** A room card's inner padding. */
const CARD_PAD = 12;
/** The card's padding under its last row, carried by that row; see `roomBody`. */
const ROOM_END = { marginBottom: CARD_PAD };
/** A line of running text, as the page sets it (`lineHeight: 1.4`). */
const LINE = B * 1.4;
/**
 * Roughly how many characters a line holds in the table's two text columns.
 *
 * The room body is 498 pt wide: the item column a third of it, in letter-spaced
 * capitals; Comments about half, in sentence case. On the low side, so an
 * estimate errs towards keeping a room's start together.
 */
const LABEL_CHARS_PER_LINE = 15;
const COMMENT_CHARS_PER_LINE = 34;

/** Photo bytes keyed by photo id, as data URIs. */
export type ReportImages = Map<string, string>;

const styles = StyleSheet.create({
  page: {
    paddingTop: 46,
    paddingBottom: 56,
    paddingHorizontal: 44,
    fontSize: B,
    lineHeight: 1.4,
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
    fontSize: B * 0.75,
    letterSpacing: 2.2,
    fontFamily: 'Helvetica-Bold',
    marginBottom: 12,
  },
  coverTitle: { color: '#ffffff', fontSize: B * 2, fontFamily: 'Helvetica-Bold', lineHeight: 1.2 },
  coverSubtitle: { color: '#cfdcf5', fontSize: B, marginTop: 5 },
  /*
   * Columns that do not fit move to a second line, and one longer than the
   * whole band wraps within itself. Kept to one line, a long form name or two
   * inspectors printed the four values over each other and pushed "ROOMS
   * INSPECTED" off the page.
   */
  coverMetaRow: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 18, columnGap: 26, rowGap: 10 },
  coverMetaCell: { maxWidth: '100%' },
  coverMetaLabel: { color: '#a9c0ee', fontSize: B * 0.7, letterSpacing: 1.1 },
  coverMetaValue: { color: '#ffffff', fontSize: B, fontFamily: 'Helvetica-Bold', marginTop: 3 },

  // ---- generic -----------------------------------------------------------
  sectionTitle: { fontSize: B * 1.3, fontFamily: 'Helvetica-Bold', marginBottom: 3 },
  sectionHint: { color: C.muted, marginBottom: 12 },

  chip: {
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 2.5,
    paddingHorizontal: 8,
    fontSize: B * 0.75,
    fontFamily: 'Helvetica-Bold',
  },

  // ---- rooms -------------------------------------------------------------
  /*
   * Spaced from the room above, never from the one below. @react-pdf moves an
   * element to the next page when its bottom margin would cross the foot of the
   * page, even when the element itself fits -- and even when it could split. A
   * bottom margin here sent the first room of every report to page two and left
   * the cover page blank (the office, 2026-10-30, a 16-page move-out).
   */
  roomCard: { borderWidth: 1, borderColor: C.border, borderRadius: 6, marginTop: ROOM_GAP },
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
    fontSize: B * 1.15,
    fontFamily: 'Helvetica-Bold',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  roomFloor: { color: C.muted, fontSize: B * 0.8, marginTop: 1 },
  /*
   * No bottom padding: the room's last row -- of the table or of photographs --
   * carries that space as its own margin (`ROOM_END`), so it travels with the
   * row. As padding it stayed behind whenever the row only just fitted, and
   * @react-pdf printed it at the top of the next page as an empty box.
   */
  roomBody: { paddingTop: CARD_PAD, paddingHorizontal: CARD_PAD },

  // Three a row, filling it: the room body is 498 pt wide, less two 8 pt gaps
  // (2026-10-08: bigger photographs). 4:3, as the cameras shoot. A row is kept
  // whole, so a page break falls between rows.
  photoRow: { flexDirection: 'row', gap: 8, marginTop: 8 },
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
  photoCaption: { fontSize: B * 0.75, fontFamily: 'Helvetica-Bold', marginTop: 3 },
  // On the photograph, bottom left, as the office's timestamp-camera reports
  // print it -- inside the frame, so the crop to fill the cell never cuts it.
  photoStamp: {
    position: 'absolute',
    left: 4,
    bottom: 4,
    fontSize: B * 0.5,
    color: '#FFFFFF',
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
    paddingHorizontal: 3,
    paddingVertical: 1.5,
    borderRadius: 2,
  },

  emptyRoom: { color: C.muted, fontSize: B, marginBottom: CARD_PAD },
  /*
   * The condition table, drawn as a grid, as InspectCloud draws it (the
   * maintenance team, 2026-10-08): a line round every cell, each Y and N in
   * the middle of its own box, and everything at the running size -- headings,
   * items, verdicts and comments alike. The verdict columns are narrow, their headings
   * turned upright to fit, so the Comments column has the room. Widths are
   * fixed rather than proportional so the columns line up down the page.
   *
   * The outline is drawn by each row, not round the table: a table broken
   * across pages then still closes at the foot of one page and opens under
   * its repeated headings on the next.
   */
  checklistHeadRow: {
    flexDirection: 'row',
    backgroundColor: C.surfaceSubtle,
    borderWidth: GRID,
    borderColor: C.border,
  },
  checklistRow: {
    flexDirection: 'row',
    borderLeftWidth: GRID,
    borderRightWidth: GRID,
    borderBottomWidth: GRID,
    borderColor: C.border,
  },
  // Every cell centres what it holds, top to bottom, so a row reads across.
  checklistCell: { paddingVertical: 4, paddingHorizontal: 4, justifyContent: 'center' },
  checklistHeadText: { fontSize: B, color: C.muted },
  checklistLabel: { width: '30%' },
  checklistLabelText: { fontSize: B, textTransform: 'uppercase', letterSpacing: 0.3 },
  checklistAxis: {
    width: '7%',
    alignItems: 'center',
    borderLeftWidth: GRID,
    borderLeftColor: C.border,
    paddingHorizontal: 0,
  },
  // The lines between the headings slant with them (2026-10-09), so the head
  // row has none of its own upright.
  checklistAxisHead: {
    height: AXIS_HEAD_HEIGHT,
    paddingVertical: 0,
    position: 'relative',
    borderLeftWidth: 0,
  },
  // A column line, from the column's bottom corner up at the headings' slant
  // to the top of the row: the line below carries on straight from it.
  checklistAxisHeadLine: {
    position: 'absolute',
    left: 0,
    bottom: 0,
    width: AXIS_HEAD_HEIGHT / SLANT_SIN,
    height: GRID,
    backgroundColor: C.border,
    transformOrigin: 'left bottom',
    transform: `rotate(-${AXIS_HEAD_SLANT}deg)`,
  },
  // Slanted at 50 degrees, rising from the middle of its column over the Y and
  // N beneath it, as InspectCloud's are: anchored at the bottom-left of the
  // name and turned about that corner, so it starts where its column is and
  // leans over the next one, which has room above its own heading.
  checklistAxisHeadText: {
    position: 'absolute',
    left: '50%',
    marginLeft: AXIS_HEAD_OFFSET,
    bottom: AXIS_HEAD_LIFT,
    width: 80,
    fontSize: B,
    lineHeight: 1,
    color: C.muted,
    transformOrigin: 'left bottom',
    transform: `rotate(-${AXIS_HEAD_SLANT}deg)`,
  },
  checklistAxisText: { fontSize: B, fontFamily: 'Helvetica-Bold' },
  // One answer where the three verdicts would be: the width of all three, so
  // the Comments column still lines up with the rows above and below it.
  checklistAnswer: {
    width: '21%',
    alignItems: 'center',
    borderLeftWidth: GRID,
    borderLeftColor: C.border,
  },
  checklistAnswerText: { fontSize: B, fontFamily: 'Helvetica-Bold' },
  checklistPass: { color: C.pass },
  checklistFail: { color: C.fail },
  checklistComment: { width: '49%', borderLeftWidth: GRID, borderLeftColor: C.border },
  // In the sentence case they were written in: only the items are in capitals.
  commentNote: { fontSize: B, color: C.muted, lineHeight: 1.3 },
  commentAction: { fontSize: B, lineHeight: 1.3 },
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
  closingBody: { fontSize: B, lineHeight: 1.4, marginTop: 2 },
  disclaimer: {
    marginTop: 16,
    padding: 12,
    backgroundColor: C.brandSoft,
    borderRadius: 6,
    fontSize: B * 0.8,
    color: C.brandDark,
    lineHeight: 1.6,
  },
  brandLine: { color: C.muted, fontSize: B * 0.75, marginTop: 10 },

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
    fontSize: B * 0.65,
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

function ChecklistTable({ room, last }: { room: ReportRoomView; last: boolean }) {
  if (!room.checklist.length) return null;
  // An occupied room answers each question once. Heading it with three verdict
  // columns it never fills is what made its answers look missing.
  const answersOnly = room.checklist.every((row) => row.kind === 'ANSWER');
  return (
    <View>
      {/* Repeated at the top of each page the table carries on to, so the
          letters there are not read without their column. */}
      <View fixed style={styles.checklistHeadRow}>
        <View style={[styles.checklistCell, styles.checklistLabel, { justifyContent: 'flex-end' }]}>
          <Text style={styles.checklistHeadText}>Room / item</Text>
        </View>
        {answersOnly ? (
          <View style={[styles.checklistCell, styles.checklistAnswer, { justifyContent: 'flex-end' }]}>
            <Text style={styles.checklistHeadText}>Condition</Text>
          </View>
        ) : (
          ['Clean', 'Undamaged', 'Working'].map((axis) => (
            <View key={axis} style={[styles.checklistCell, styles.checklistAxis, styles.checklistAxisHead]}>
              <View style={styles.checklistAxisHeadLine} />
              {axis === 'Working' ? <View style={[styles.checklistAxisHeadLine, { left: '100%' }]} /> : null}
              <Text style={styles.checklistAxisHeadText}>{axis}</Text>
            </View>
          ))
        )}
        <View
          style={[
            styles.checklistCell,
            styles.checklistComment,
            // The line before it slants up from Working's corner instead; and
            // centred, clear of that line and of "Working" leaning over it.
            { justifyContent: 'flex-end', alignItems: 'center', borderLeftWidth: answersOnly ? GRID : 0 },
          ]}
        >
          <Text style={styles.checklistHeadText}>Comments</Text>
        </View>
      </View>
      {room.checklist.map((row, index) => (
        // Whole on one page: a row that does not fit moves to the next one.
        // Split, its blank cells broke across the page with their borders cut,
        // and a label on two lines -- which cannot split -- was drawn whole
        // past the foot of the page, over the footer (the office, 2026-10-30:
        // "LIGHTS AND POWER POINTS" across "Page 10 of 16"). A row taller than
        // a whole page would still be cut, but that is a comment of 40 lines.
        <View
          key={row.id}
          style={[styles.checklistRow, last && index === room.checklist.length - 1 ? ROOM_END : {}]}
          wrap={false}
        >
          <View style={[styles.checklistCell, styles.checklistLabel]}>
            <Text style={styles.checklistLabelText}>{row.label}</Text>
          </View>
          {row.kind === 'ANSWER' ? (
            <View style={[styles.checklistCell, styles.checklistAnswer]}>
              <Text style={styles.checklistAnswerText}>{row.answer}</Text>
            </View>
          ) : (
            // Colour is an accent on the letter, never a substitute for it --
            // the table has to survive a monochrome print.
            [row.clean, row.undamaged, row.working].map((value, index) => (
              <View key={index} style={[styles.checklistCell, styles.checklistAxis]}>
                <Text style={[styles.checklistAxisText, axisTone(value)]}>{value}</Text>
              </View>
            ))
          )}
          {/* The reviewer's comment, then what the room needs that is about
              this item, from the summary of its recordings, one line each. */}
          <View style={[styles.checklistCell, styles.checklistComment]}>
            {row.comment ? <Text style={styles.commentNote}>{row.comment}</Text> : null}
            {row.actions.map((action) => (
              <Text key={action} style={styles.commentAction}>
                {action}
              </Text>
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

/**
 * Photographs three to a row, each row a unit of its own. A wrapping grid let
 * @react-pdf break a row between its photographs, and its last one could not
 * carry the card's bottom padding with it.
 */
function photoRows<T>(photos: T[]) {
  const rows: T[][] = [];
  for (let index = 0; index < photos.length; index += 3) rows.push(photos.slice(index, index + 3));
  return rows;
}

/** Lines a piece of text takes in a column of `perLine` characters. */
function linesOf(text: string, perLine: number) {
  return text ? Math.ceil(text.length / perLine) : 0;
}

/**
 * How tall the start of a room is: its header, its table's headings and first
 * row -- or its first photograph -- which have to share a page.
 *
 * An estimate from character counts, since the layout is not known until it is
 * done; it errs high, so the worst it does is start a room on the next page a
 * little early.
 */
function roomStartHeight(room: ReportRoomView, photos: ReportRoomView['photos']) {
  const header = 16 + B * 1.15 * 1.4 + (room.floorName ? B * 0.8 * 1.4 + 1 : 0) + 2;
  const first = room.checklist[0];
  if (first) {
    const head = room.checklist.every((row) => row.kind === 'ANSWER') ? LINE + 8 : AXIS_HEAD_HEIGHT;
    const lines = Math.max(
      1,
      linesOf(first.label, LABEL_CHARS_PER_LINE),
      [first.comment, ...first.actions].reduce(
        (sum, text) => sum + linesOf(text, COMMENT_CHARS_PER_LINE),
        0,
      ),
    );
    return header + CARD_PAD + head + lines * LINE + 8 + 4;
  }
  return header + CARD_PAD + (photos.length ? 120 + B * 0.75 * 1.4 + 3 : LINE) + CARD_PAD + 4;
}

function Room({ room, images, first }: { room: ReportRoomView; images: ReportImages; first: boolean }) {
  const photos = room.photos.filter((photo) => images.has(photo.id));
  return (
    // Small rooms stay whole on one page; large ones are allowed to split
    // rather than leaving most of a page blank.
    <View
      style={[styles.roomCard, first ? { marginTop: 0 } : {}]}
      wrap={room.checklist.length + photos.length > 4}
    >
      <View style={styles.roomHeader}>
        {/* Wraps clear of the status chip rather than running under it. */}
        <View style={{ flexShrink: 1, marginRight: 12 }}>
          <Text style={styles.roomName}>{room.name}</Text>
          {room.floorName ? <Text style={styles.roomFloor}>{room.floorName}</Text> : null}
        </View>
        <Chip label={room.statusLabel} tone={room.inspected ? INSPECTED_TONE : QUIET_TONE} />
      </View>
      <View style={styles.roomBody}>
        <ChecklistTable last={!photos.length} room={room} />
        {photoRows(photos).map((row, index, rows) => (
          <View
            key={row[0]!.id}
            style={[
              styles.photoRow,
              // Under the table, or straight under the header's padding.
              index === 0 && !room.checklist.length ? { marginTop: 0 } : {},
              index === rows.length - 1 ? ROOM_END : {},
            ]}
            wrap={false}
          >
            {row.map((photo) => (
              <View key={photo.id} style={styles.photoCell}>
                <View style={styles.photoFrame}>
                  <Image style={styles.photo} src={images.get(photo.id)!} />
                  {photo.stamp ? <Text style={styles.photoStamp}>{photo.stamp}</Text> : null}
                </View>
                {photo.caption ? <Text style={styles.photoCaption}>{photo.caption}</Text> : null}
              </View>
            ))}
          </View>
        ))}
        {!room.checklist.length && !photos.length ? (
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
            <View style={styles.coverMetaCell}>
              <Text style={styles.coverMetaLabel}>INSPECTION TEMPLATE</Text>
              <Text style={styles.coverMetaValue}>{view.templateLabel}</Text>
            </View>
            {view.inspectorLabel ? (
              <View style={styles.coverMetaCell}>
                <Text style={styles.coverMetaLabel}>INSPECTOR</Text>
                <Text style={styles.coverMetaValue}>{view.inspectorLabel}</Text>
              </View>
            ) : null}
            <View style={styles.coverMetaCell}>
              <Text style={styles.coverMetaLabel}>DATE</Text>
              <Text style={styles.coverMetaValue}>{view.dateLabel}</Text>
            </View>
            {/* The one count the report keeps. The "At a glance" counters and
                the summary of findings that used to fill the first page are
                gone with the findings lists they counted (2026-10-07), so
                the rooms start on the cover page. */}
            <View style={styles.coverMetaCell}>
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
        {roomsWithEvidence.map((room, index) => (
          <Fragment key={room.id}>
            {/* Nothing to draw: it moves the room to the next page when less
                than its start is left on this one, rather than leaving its
                header, or its table's headings, alone at the foot of a page.
                @react-pdf only weighs what follows an element, so the room
                cannot ask this of itself. */}
            <View
              minPresenceAhead={
                (index === 0 ? 0 : ROOM_GAP) +
                roomStartHeight(
                  room,
                  room.photos.filter((photo) => images.has(photo.id)),
                )
              }
            />
            <Room first={index === 0} images={images} room={room} />
          </Fragment>
        ))}

        {quietRooms.length ? (
          <View style={{ marginTop: ROOM_GAP }} wrap={false}>
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

        {/* Whole, like the closing block: split, it left an empty strip of
            its tint at the foot of one page and the text on the next. */}
        <View style={styles.disclaimer} wrap={false}>
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
