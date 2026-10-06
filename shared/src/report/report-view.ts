/**
 * The one content layer behind both renderings of an inspection report: the
 * public web page (HTML/CSS) and the emailed PDF (@react-pdf primitives).
 *
 * Those two use entirely different layout engines, so nothing about their
 * markup can be shared. What *can* be shared — and what actually drifts when it
 * isn't — is the content: which sections exist, in what order, how enums are
 * worded, how severities rank and colour. That all lives here, and both
 * renderers are reduced to styling a `ReportView` they did not compute.
 *
 * Pure and dependency-free: it runs in Node for PDF generation and in the
 * browser for the web page.
 */
import type {
  PublicInspectionReport,
  PublicReportChecklistItem,
  PublicReportPhoto,
} from '../contracts/admin.js';
import { formatPhotoStamp, PHOTO_STAMP_TIME_ZONE } from '../contracts/photo-capture-time.js';

export type ReportSeverity = 'HIGH' | 'MEDIUM' | 'LOW';

/** Most severe first — the order findings are presented in everywhere. */
export const REPORT_SEVERITY_ORDER: readonly ReportSeverity[] = ['HIGH', 'MEDIUM', 'LOW'] as const;

export interface ReportTone {
  /** Text/border colour. */
  accent: string;
  /** Fill behind the accent. */
  surface: string;
  border: string;
}

/**
 * Print-safe values taken from the application's light theme (`globals.css`),
 * so a downloaded PDF looks like the product it came from. Literal hex rather
 * than CSS variables: @react-pdf has no cascade to resolve them against.
 */
export const REPORT_PALETTE = {
  brand: '#1d4492',
  brandDark: '#142f66',
  brandSoft: '#e5ecfa',
  accent: '#85c43f',
  accentDark: '#527a24',
  accentSoft: '#eef7e4',
  text: '#14213a',
  muted: '#5b6b87',
  border: '#d9e0ea',
  surface: '#ffffff',
  surfaceSubtle: '#f5f7fb',
  /**
   * Checklist verdicts. Named for what they mean rather than reused from the
   * severity scale: a failed axis is not a severity, and tying them together
   * would make a palette change to one silently restyle the other.
   *
   * The letter still carries the meaning — these are an accent on top of a Y
   * or an N, never a substitute for it, so the table survives monochrome
   * printing and colour blindness.
   */
  pass: '#527a24',
  fail: '#b64040',
} as const;

const SEVERITY_TONE: Record<ReportSeverity, ReportTone> = {
  HIGH: { accent: '#b64040', surface: '#f8e1e1', border: '#e9bcbc' },
  MEDIUM: { accent: '#94601b', surface: '#f8ebd2', border: '#e6cf9f' },
  LOW: { accent: '#1d4492', surface: '#e5ecfa', border: '#c2d0ee' },
};

const SEVERITY_LABEL: Record<ReportSeverity, string> = {
  HIGH: 'High priority',
  MEDIUM: 'Moderate',
  LOW: 'Minor',
};

/** Room completion states, worded for a homeowner rather than an operator. */
const ROOM_STATUS_LABEL: Record<string, string> = {
  COMPLETED: 'Inspected',
  PENDING: 'Not inspected',
  IN_PROGRESS: 'Partly inspected',
  SKIPPED: 'Skipped',
  BLOCKED: 'Could not access',
};

/** Plain-language readings of the AI comparison verdicts. */
const COMPARISON_LABEL: Record<string, string> = {
  EXISTING_CONDITION: 'Pre-existing condition',
  POSSIBLE_NEW_DAMAGE: 'Possible new damage',
  NO_MATERIAL_CHANGE: 'No material change',
  NORMAL_WEAR: 'Normal wear and tear',
  OWNER_MAINTENANCE: 'Owner maintenance item',
  MISSING_EVIDENCE: 'Evidence incomplete',
  INSUFFICIENT_DATA: 'Not enough information',
};

export function formatEnumLabel(value: string) {
  return value
    .replaceAll('_', ' ')
    .toLowerCase()
    .replace(/(^|\s)\S/g, (character) => character.toUpperCase());
}

function toSeverity(value: string): ReportSeverity {
  return value === 'HIGH' || value === 'MEDIUM' || value === 'LOW' ? value : 'LOW';
}

/**
 * A day, as the report prints it: "October 1, 2026".
 *
 * `moment` for a time something happened -- a completion, the report's
 * generation -- read in Texas. Read in UTC, a visit finished after 7 pm in
 * Houston printed as completed the next day. A scheduled day stays in UTC,
 * which is how a date-only visit is stored.
 */
export function formatReportDay(value?: string | Date | null, moment = false) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: moment ? PHOTO_STAMP_TIME_ZONE : 'UTC',
  }).format(date);
}

const formatDay = formatReportDay;

export interface ReportPhotoView {
  id: string;
  caption: string | null;
  notes: string | null;
  /**
   * The capture time drawn on the photograph, in Texas time with its zone.
   *
   * Null when the time's origin is not known: a stamp on evidence has to be
   * right or absent. It used to print every photograph's time in UTC with no
   * zone, which read five or six hours late in Houston.
   */
  stamp: string | null;
  contentPath: string;
  /** The capture time and its origin, for a viewer that draws its own stamp. */
  capturedAt: string | null;
  captureTimeSource: PublicReportPhoto['captureTimeSource'] | null;
}

export interface ReportFindingView {
  id: string;
  title: string;
  description: string;
  categoryLabel: string;
  severity: ReportSeverity;
  severityLabel: string;
  tone: ReportTone;
  comparisonLabel: string;
  baselineCondition: string | null;
  roomName: string;
}

/**
 * One checklist row, pre-formatted for printing.
 *
 * The axes arrive as tri-states and leave as the strings the page prints:
 * "Y", "N" or an **empty string** for unassessed. Doing the mapping here rather
 * than in each renderer is what guarantees the HTML page and the PDF cannot
 * disagree about what a blank cell means — and a blank is the whole point, as
 * the office's existing reports leave unassessed rows empty rather than
 * claiming a defect nobody observed.
 */
export interface ReportChecklistRowView {
  id: string;
  label: string;
  /**
   * How the row is printed. AXES is the clean / undamaged / working verdict;
   * ANSWER is one recorded answer -- an occupied room's "Clean" or "Good" --
   * printed across the three verdict columns instead of leaving them blank.
   */
  kind: 'AXES' | 'ANSWER';
  /** The recorded answer, for an ANSWER row. Empty when nothing was chosen. */
  answer: string;
  clean: string;
  undamaged: string;
  working: string;
  comment: string;
}

/**
 * What the inspector said in one recording of a room, as the report prints it:
 * one run of text, each utterance opening with the minute and second it was
 * spoken at -- "[0:05] Dining room has part pantry. [0:10] Need to ..." -- the
 * way the maintenance team's own reports set it out (2026-10-07).
 */
export interface ReportNarrationView {
  /** The clip's label, for an extra recording; null for the room's walkthrough. */
  label: string | null;
  text: string;
}

/** The heading over a room's narration, the office's own wording. */
export const NARRATION_HEADING = 'Summary based on the recordings';

export interface ReportRoomView {
  id: string;
  name: string;
  floorName: string | null;
  statusLabel: string;
  /** True only for COMPLETED, so renderers can accent inspected rooms. */
  inspected: boolean;
  skipReason: string | null;
  /** Condition rows, in the order an administrator authored the checklist. */
  checklist: ReportChecklistRowView[];
  photos: ReportPhotoView[];
  /**
   * The office's confirmed findings for the room. Kept on the view for the
   * comparison report and the counts; the inspection report itself no longer
   * prints them (the maintenance team, 2026-10-07: too much -- the table says
   * what failed, the comments say why, and the narration says it verbatim).
   */
  findings: ReportFindingView[];
  /** What was said walking the room, under its photographs. Empty when nothing was transcribed. */
  narration: ReportNarrationView[];
  /** False when the room has no checklist, photos, findings or narration — render compactly. */
  hasEvidence: boolean;
}

/** "0:05", "12:40" -- a second in the recording as the report prints it. */
export function formatNarrationTime(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${minutes}:${rest < 10 ? '0' : ''}${rest}`;
}

/** One recording's lines as one run of text; see `ReportNarrationView`. */
export function narrationText(lines: ReadonlyArray<{ start: number; text: string }>) {
  return lines
    .map((line) => `[${formatNarrationTime(line.start)}] ${line.text.trim()}`)
    .filter((entry) => entry.length > '[0:00] '.length)
    .join(' ');
}

/** Tri-state to printed cell. Null and undefined both mean "not assessed". */
function axisCell(value: boolean | null | undefined) {
  if (value === true) return 'Y';
  if (value === false) return 'N';
  return '';
}

/**
 * Words worth matching on, from a checklist label or a finding's category.
 *
 * Singularised and stripped of joining words, because the two vocabularies
 * never agree on either: the checklist says "Doors and locks" and "Smoke
 * alarms", the AI files findings under "Doors", "Smoke alarm" and "Flooring".
 */
const MATCH_STOPWORDS = new Set(['and', 'or', 'the', 'for', 'of', 'in', 'on', 'to', 'any', 'not']);

function matchTokens(value: string): Set<string> {
  const tokens = value
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((word) => word.length > 2 && !MATCH_STOPWORDS.has(word))
    // "alarms" and "alarm" are the same item; "coverings" and "covering" too.
    .map((word) => (word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word));
  return new Set(tokens);
}

/**
 * Two words name the same thing.
 *
 * A prefix rather than equality, because the checklist and the AI inflect the
 * same noun differently — "Floor and coverings" against "Flooring", "Lights and
 * power points" against "Lighting". Four characters minimum, so short words
 * still have to match exactly: "fan" must not reach "fancy".
 */
function sameSubject(a: string, b: string) {
  if (a === b) return true;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.startsWith(short);
}

/**
 * Does this finding explain this checklist row?
 *
 * Matching the two labels for equality — which is what this did — succeeds
 * almost never. Of six failed rows on a real two-room report exactly one
 * matched ("Doors and locks" against the category "Doors and locks"); "Floor
 * and coverings" missed "Flooring", "Walls and ceilings" missed "Walls", and
 * "Smoke alarms" missed "Smoke alarm", so five rows printed a bare N with an
 * empty comment column.
 *
 * A shared word is the right test because the checklist item already carries
 * the vocabulary for it. `keywords` exists to recognise the item in a
 * transcript, which is the same job.
 */
function explains(item: PublicReportChecklistItem, note: CommentSource): boolean {
  // The category, and the thing the title names before its colon: "Outlet
  // cover: missing" is about an outlet whatever category it was filed under.
  const subject = matchTokens(note.category);
  const colon = note.title.indexOf(':');
  if (colon > 0) for (const word of matchTokens(note.title.slice(0, colon))) subject.add(word);
  if (!subject.size) return false;
  const itemWords = matchTokens(item.label);
  for (const keyword of item.keywords ?? [])
    for (const word of matchTokens(keyword)) itemWords.add(word);
  for (const word of itemWords)
    for (const other of subject) if (sameSubject(word, other)) return true;
  return false;
}

/** What a comment is drawn from: a finding's category and its title. */
type CommentSource = { roomId?: string | null; roomName: string; category: string; title: string };

/** At most this many comments beside one row: the column is a note, not a list. */
const MAX_ROW_COMMENTS = 3;
/** A comment longer than this is cut at a word. Titles are asked for in eight words. */
const MAX_COMMENT_LENGTH = 80;

/**
 * Words that say no more than a row's Y/N columns: its verdicts, and the
 * filler the AI wraps them in ("recorded as", "unspecified", "condition").
 * Singular, as `matchTokens` leaves them.
 */
const ECHO_WORDS = new Set(
  (
    'recorded reported marked noted listed checklist assessment rating rated condition status ' +
    'item issue problem unspecified detail without described general overall additional area part ' +
    'all both some the and with ha have had are wa were been being its their also appear seem ' +
    'require required requiring need needed needing check fail failed failing not non functional ' +
    'functioning function working work operational operating clean cleaned unclean cleaning ' +
    'cleanliness dirty dirt damage damaged unknown room'
  ).split(' '),
);

/**
 * A title that says nothing the row does not: "Walls and ceilings: not clean",
 * "Kitchen door recorded as unclean", "Dishwasher is damaged", "Lawn and
 * garden: damage recorded without details". The AI filed one for every failed
 * checklist answer (10830 Harston Dr, 2026-10-07: dozens of its 227 findings),
 * worded a different way each time, and beside the row it repeats it is noise.
 *
 * What is left of the title once the row's own words, the room's name and
 * the verdicts are taken out: nothing, and it is an echo. "Sliding door
 * locking mechanism damaged" leaves "sliding mechanism", and is kept.
 */
export function restatesChecklist(
  title: string,
  item: Pick<PublicReportChecklistItem, 'label' | 'keywords'>,
  roomName = '',
) {
  const known = matchTokens(item.label);
  for (const keyword of item.keywords ?? []) for (const word of matchTokens(keyword)) known.add(word);
  for (const word of matchTokens(roomName)) known.add(word);
  const said = [...matchTokens(title)];
  return said.every(
    (word) => ECHO_WORDS.has(word) || [...known].some((other) => sameSubject(word, other)),
  );
}

/** A title as a comment: short, and cut at a word when it is not. */
export function commentText(title: string) {
  const text = title.trim().replace(/\s+/g, ' ');
  if (text.length <= MAX_COMMENT_LENGTH) return text;
  const cut = text.slice(0, MAX_COMMENT_LENGTH - 1);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 40 ? cut.lastIndexOf(' ') : cut.length)}…`;
}

export interface ReportSeverityCount {
  severity: ReportSeverity;
  label: string;
  count: number;
  tone: ReportTone;
}

export interface ReportView {
  brand: PublicInspectionReport['brand'];
  title: string;
  subtitle: string;
  inspectionLabel: string;
  /**
   * The office's own name for the form, when the deployment supplies one —
   * "Exit Inspection" rather than "Move out inspection". Falls back to the
   * enum-derived label so a report is never headed by a blank.
   */
  templateLabel: string;
  /** Who carried it out; empty when nobody is assigned. */
  inspectorLabel: string;
  /**
   * The closing block, already filtered to what was actually written.
   *
   * Empty when the reviewer wrote nothing, so a renderer can skip the whole
   * section rather than printing three headings over three blanks.
   */
  closingNotes: { label: string; body: string }[];
  dateLabel: string;
  summary: {
    headline: string;
    roomsTotal: number;
    roomsInspected: number;
    findingsTotal: number;
    severityCounts: ReportSeverityCount[];
  };
  rooms: ReportRoomView[];
  /** Findings whose room no longer resolves; never silently dropped. */
  otherFindings: ReportFindingView[];
  /** Every finding, most severe first — drives the summary section. */
  allFindings: ReportFindingView[];
  generatedLabel: string;
  disclaimer: string;
}

/**
 * What the report is, said truthfully: the checklist comments are drawn from
 * the recording whether or not anyone has confirmed them yet, and the narration
 * under each room's photographs is the recording itself, word for word
 * (2026-10-07).
 */
const DISCLAIMER =
  'The condition table is as the inspector scored it. The comments beside the checklist are ' +
  "drawn automatically from the inspector's walkthrough recording, and the summary under each " +
  "area's photographs is that recording, word for word. This report is informational: it does " +
  'not by itself authorize charges or determine responsibility for any condition described.';

/** A photograph as a report prints it; shared with the comparison report. */
export function reportPhotoView(photo: PublicReportPhoto): ReportPhotoView {
  return {
    id: photo.id,
    caption: photo.label?.trim() || null,
    notes: photo.notes?.trim() || null,
    stamp: formatPhotoStamp(photo.capturedAt, photo.captureTimeSource),
    contentPath: photo.contentPath,
    capturedAt: photo.capturedAt ?? null,
    captureTimeSource: photo.captureTimeSource ?? null,
  };
}

function mapFinding(finding: PublicInspectionReport['findings'][number]): ReportFindingView {
  const severity = toSeverity(finding.severity);
  return {
    id: finding.id,
    title: finding.title,
    description: finding.description,
    categoryLabel: formatEnumLabel(finding.category),
    severity,
    severityLabel: SEVERITY_LABEL[severity],
    tone: SEVERITY_TONE[severity],
    comparisonLabel:
      COMPARISON_LABEL[finding.comparisonResult] ?? formatEnumLabel(finding.comparisonResult),
    baselineCondition: finding.baselineCondition?.trim() || null,
    roomName: finding.roomName,
  };
}

function bySeverity(a: ReportFindingView, b: ReportFindingView) {
  return REPORT_SEVERITY_ORDER.indexOf(a.severity) - REPORT_SEVERITY_ORDER.indexOf(b.severity);
}

export function buildReportView(report: PublicInspectionReport): ReportView {
  const photosByRoom = new Map<string, ReportPhotoView[]>();
  for (const photo of report.photos ?? []) {
    const list = photosByRoom.get(photo.roomId);
    if (list) list.push(reportPhotoView(photo));
    else photosByRoom.set(photo.roomId, [reportPhotoView(photo)]);
  }

  const findings = report.findings.map(mapFinding);
  const findingsByRoom = new Map<string, ReportFindingView[]>();
  const roomIds = new Set(report.rooms.map((room) => room.id));
  const orphaned: ReportFindingView[] = [];
  report.findings.forEach((source, index) => {
    const view = findings[index];
    // A finding is anchored to its room by id; fall back to the room name so a
    // renamed or merged area still groups instead of vanishing from the report.
    const byId = source.roomId && roomIds.has(source.roomId) ? source.roomId : null;
    const byName = byId ? null : report.rooms.find((room) => room.name === source.roomName)?.id;
    const key = byId ?? byName;
    if (!key) {
      orphaned.push(view);
      return;
    }
    const list = findingsByRoom.get(key);
    if (list) list.push(view);
    else findingsByRoom.set(key, [view]);
  });

  /**
   * What the comments are drawn from, by room: every finding the office has
   * not rejected, confirmed or not (the office, 2026-10-07: the comments
   * "are not generated" while 227 findings waited to be confirmed). A report
   * from an older backend carries only the confirmed ones.
   */
  const notesByRoom = new Map<string, CommentSource[]>();
  for (const note of report.checklistNotes ?? report.findings) {
    const key =
      note.roomId && roomIds.has(note.roomId)
        ? note.roomId
        : report.rooms.find((room) => room.name === note.roomName)?.id;
    if (!key) continue;
    notesByRoom.set(key, [...(notesByRoom.get(key) ?? []), note]);
  }

  const rooms: ReportRoomView[] = report.rooms.map((room) => {
    const photos = photosByRoom.get(room.id) ?? [];
    const roomFindings = (findingsByRoom.get(room.id) ?? []).sort(bySeverity);
    // Defaulted: a report generated against a backend that predates
    // assessments has no checklist at all, which prints as no table rather
    // than an empty one.
    const checklist: ReportChecklistRowView[] = (room.checklist ?? []).map((item) => {
      /**
       * A failed axis is explained by what the walkthrough found about it.
       *
       * The office's report never prints a bare "N" — the comment column is
       * where a reader learns what was wrong. The AI already wrote that from
       * the technician's narration and filed it as findings, so this surfaces
       * existing words rather than inventing new ones. Nothing is generated
       * here.
       *
       * A finding's **title**, not its description (2026-10-07: "keep it short
       * and simple, and precise"), and never one that only says the row's N
       * back. Every matching one up to three, not the first: a room can have
       * two things wrong with its walls.
       *
       * Only when an axis actually failed. A row scored all-Y needs no
       * explanation, and attaching one would read as a defect.
       */
      const failed =
        item.isClean === false || item.isUndamaged === false || item.isWorking === false;
      const written = item.comment?.trim() || '';
      const borrowed = failed
        ? [
            ...new Set(
              (notesByRoom.get(room.id) ?? [])
                .filter(
                  (note) => explains(item, note) && !restatesChecklist(note.title, item, room.name),
                )
                .map((note) => commentText(note.title))
                .filter(Boolean),
            ),
          ].slice(0, MAX_ROW_COMMENTS)
        : [];
      // The reviewer's own words lead; the findings follow rather than being
      // replaced by it, so writing one note never hides the rest.
      // Anything but a three-axis verdict is one answer: an occupied room's
      // choice, or an HVAC reading printed with its unit ("72 °F"); see
      // `PublicReportChecklistItem`.
      const kind = item.responseType && item.responseType !== 'STATUS' ? 'ANSWER' : 'AXES';
      return {
        id: item.id,
        label: item.label,
        kind,
        answer: kind === 'ANSWER' ? item.textValue?.trim() || '' : '',
        clean: axisCell(item.isClean),
        undamaged: axisCell(item.isUndamaged),
        working: axisCell(item.isWorking),
        // "Tenant reported it at move-in. Wall: two cracks; Ceiling: water stain"
        comment: [written, borrowed.filter((text) => text !== written).join('; ')]
          .filter(Boolean)
          .join(' '),
      };
    });
    // Defaulted like the checklist: a report from an older backend carries no
    // narration, and a recording that said nothing prints nothing.
    const narration: ReportNarrationView[] = (room.narration ?? [])
      .map((recording) => ({
        label: recording.label?.trim() || null,
        text: narrationText(recording.lines),
      }))
      .filter((recording) => recording.text.length > 0);
    return {
      id: room.id,
      name: room.name,
      floorName: room.floorName ?? null,
      statusLabel: ROOM_STATUS_LABEL[room.completionStatus] ?? formatEnumLabel(room.completionStatus),
      inspected: room.completionStatus === 'COMPLETED',
      skipReason: room.skipReason?.trim() || null,
      checklist,
      photos,
      findings: roomFindings,
      narration,
      hasEvidence:
        checklist.length > 0 || photos.length > 0 || roomFindings.length > 0 || narration.length > 0,
    };
  });

  const severityCounts = REPORT_SEVERITY_ORDER.map((severity) => ({
    severity,
    label: SEVERITY_LABEL[severity],
    count: findings.filter((finding) => finding.severity === severity).length,
    tone: SEVERITY_TONE[severity],
  }));

  const roomsInspected = rooms.filter((room) => room.inspected).length;
  const roomsWithFindings = rooms.filter((room) => room.findings.length > 0).length;
  const headline = findings.length
    ? `${findings.length} ${findings.length === 1 ? 'finding' : 'findings'} across ` +
      `${roomsWithFindings} ${roomsWithFindings === 1 ? 'room' : 'rooms'}`
    : 'No findings were confirmed during review';

  const property = report.property;
  const unit = property.unitName ? `, Unit ${property.unitName}` : '';
  const completed = formatDay(report.inspection.completedAt, true);
  const scheduled = formatDay(report.inspection.scheduledAt);

  return {
    brand: report.brand,
    title: `${property.addressLine1 || property.name}${unit}`,
    subtitle: [property.city, property.state, property.postalCode].filter(Boolean).join(', '),
    inspectionLabel: `${formatEnumLabel(report.inspection.type)} inspection`,
    templateLabel:
      report.inspection.templateLabel?.trim() ||
      `${formatEnumLabel(report.inspection.type)} inspection`,
    inspectorLabel: report.inspection.inspector?.trim() ?? '',
    // Built here so the HTML page and the PDF print the same headings in the
    // same order as the office's own report.
    closingNotes: (
      [
        ['Next inspection alert', report.closing?.nextInspectionAlert],
        ['Maintenance comments', report.closing?.maintenanceComments],
        ['General comments', report.closing?.generalComments],
      ] as const
    )
      .filter(([, body]) => Boolean(body?.trim()))
      .map(([label, body]) => ({ label, body: body!.trim() })),
    dateLabel: completed
      ? `Completed ${completed}`
      : scheduled
        ? `Scheduled ${scheduled}`
        : 'Date not recorded',
    summary: {
      headline,
      roomsTotal: rooms.length,
      roomsInspected,
      findingsTotal: findings.length,
      severityCounts,
    },
    rooms,
    otherFindings: orphaned.sort(bySeverity),
    allFindings: [...findings].sort(bySeverity),
    generatedLabel: formatDay(report.generatedAt, true) ?? '',
    disclaimer: DISCLAIMER,
  };
}
