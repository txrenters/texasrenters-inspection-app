/**
 * The content layer behind every rendering of a move-in / move-out comparison:
 * the page an owner or tenant opens from a share link, its PDF, and the console's
 * preview of both.
 *
 * As with `buildReportView`, the renderers only style what this computes.
 * Everything a reader is told -- which verdict a room has and in what words, what
 * the two inspections recorded item by item, what needs cleaning, what the office
 * confirmed from the recordings -- is decided here once, so the page, the PDF and
 * the preview cannot drift apart.
 *
 * Written for the reader the link goes to, not for the office (2026-10-06). The
 * comparison's working vocabulary -- match methods and their confidence,
 * version numbers, the AI's notes -- stays in the console.
 *
 * Plain words, the result first (2026-10-09). A tenant told the office the
 * report could not be understood: it printed every item of every room in the
 * inspector's words ("Sound", "Undam."), three kinds of table, every photograph,
 * and the same facts four times over. Now it opens on what was found, marks
 * every grade with one of four signs, shows in each room only what changed, and
 * puts the rooms the two inspections do not share at the end.
 *
 * Pure and dependency-free: it runs in Node for the PDF and in the browser.
 */
import type {
  AdminComparisonItemSide,
  ComparisonItemChange,
  ComparisonReport,
  ComparisonReportArea,
  ComparisonReportAreaSide,
  ComparisonReportItem,
} from '../contracts/admin.js';
import {
  formatEnumLabel,
  formatReportDay,
  REPORT_PALETTE,
  reportPhotoView,
  type ReportPhotoView,
  type ReportTone,
} from './report-view.js';

const C = REPORT_PALETTE;

/** What a verdict, a change or a chip means for the tenancy, as a colour. */
export type ComparisonToneName = 'damage' | 'sound' | 'neutral' | 'cleaning';

export const COMPARISON_TONE: Record<ComparisonToneName, ReportTone> = {
  damage: { accent: C.fail, surface: '#f8e1e1', border: '#e9bcbc' },
  sound: { accent: C.pass, surface: C.accentSoft, border: '#cfe3b8' },
  neutral: { accent: C.muted, surface: C.surfaceSubtle, border: C.border },
  cleaning: { accent: '#94601b', surface: '#f8ebd2', border: '#e6cf9f' },
};

/**
 * The four signs every grade is told in. Each is drawn with an icon and a
 * word, never colour alone, so the report reads in black and white too.
 */
export type ComparisonMarkKind = 'good' | 'damaged' | 'dirty' | 'none';

export interface ComparisonMark {
  kind: ComparisonMarkKind;
  label: string;
}

export const COMPARISON_MARK_TONE: Record<ComparisonMarkKind, ReportTone> = {
  good: COMPARISON_TONE.sound,
  damaged: COMPARISON_TONE.damage,
  dirty: COMPARISON_TONE.cleaning,
  none: COMPARISON_TONE.neutral,
};

/** The key printed above the rooms. */
export const COMPARISON_KEY: readonly ComparisonMark[] = [
  { kind: 'good', label: 'Good' },
  { kind: 'damaged', label: 'Damaged' },
  { kind: 'dirty', label: 'Dirty' },
  { kind: 'none', label: 'Not checked' },
];

/**
 * Photographs shown per side of a room on the web page before "Show all": one
 * row, enough to see the room, short enough that every room stays short.
 */
export const COMPARISON_PHOTO_PREVIEW = 2;

/** Each verdict, worded for the owner or tenant reading it. */
const VERDICT: Record<string, { label: string; tone: ComparisonToneName; mark: ComparisonMarkKind }> = {
  NEW_DAMAGE: { label: 'New damage', tone: 'damage', mark: 'damaged' },
  WORSENED: { label: 'Worse than at move-in', tone: 'damage', mark: 'damaged' },
  UNCHANGED: { label: 'No new damage', tone: 'sound', mark: 'good' },
  IMPROVED: { label: 'Better than at move-in', tone: 'sound', mark: 'good' },
  RESOLVED: { label: 'Better than at move-in', tone: 'sound', mark: 'good' },
  // Damage the record cannot call new or old: its sentence says why.
  NOT_COMPARABLE: { label: "Can't tell what's new", tone: 'neutral', mark: 'none' },
  // No longer drawn (2026-10-07); a comparison still holding one is redrawn
  // before it is read.
  REQUIRES_REVIEW: { label: 'Under review', tone: 'neutral', mark: 'none' },
};

/** A room the two inspections do not both have: listed at the end, not compared. */
const NOT_COMPARED = new Set(['MISSING_BASELINE', 'MISSING_MOVE_OUT_EVIDENCE']);

function verdictOf(classification: string) {
  return (
    VERDICT[classification] ?? {
      label: formatEnumLabel(classification),
      tone: 'neutral' as const,
      mark: 'none' as const,
    }
  );
}

/** What happened to one item, when anything did. "No change" says nothing. */
const RESULT: Partial<Record<ComparisonItemChange, { label: string; tone: ComparisonToneName }>> = {
  NEW_DAMAGE: { label: 'New damage', tone: 'damage' },
  ALREADY_DAMAGED: { label: 'Already damaged at move-in', tone: 'neutral' },
  REPAIRED: { label: 'Fixed since move-in', tone: 'sound' },
  NO_BASELINE: { label: 'Not checked at move-in', tone: 'neutral' },
};

/** Room completion, as the inspection report words it. */
const ROOM_STATUS: Record<string, string> = {
  COMPLETED: 'Inspected',
  // Filmed, the upload not yet confirmed: the room was walked.
  RECORDED: 'Inspected',
  UPLOADED: 'Inspected',
  PENDING: 'Not inspected',
  RECORDING: 'Not inspected',
  FAILED: 'Not inspected',
  SKIPPED: 'Skipped',
};

const SEVERITY: Record<string, { label: string; tone: ComparisonToneName }> = {
  HIGH: { label: 'High priority', tone: 'damage' },
  MEDIUM: { label: 'Moderate', tone: 'cleaning' },
  LOW: { label: 'Minor', tone: 'neutral' },
};

/** Where a room a technician added on the day is filed: not a floor anyone has. */
const ADDED_AREAS = /^added areas?$/i;

type Grades = Pick<AdminComparisonItemSide, 'clean' | 'undamaged' | 'working'>;

/** Damaged or not working: true; graded sound: false; not graded for damage: null. */
function damageOf(side: Grades | null) {
  if (!side) return null;
  if (side.undamaged === false || side.working === false) return true;
  if (side.undamaged === true || side.working === true) return false;
  return null;
}

/**
 * One side's grades as signs: condition first, then dirt. "Damaged, not
 * working" and "Dirty" are two marks, because they answer two questions --
 * harm to the property, and the tenant's cleaning.
 */
export function comparisonMarks(side: Grades | null): ComparisonMark[] {
  if (!side) return [{ kind: 'none', label: 'Not checked' }];
  const marks: ComparisonMark[] = [];
  const harm = [side.undamaged === false && 'damaged', side.working === false && 'not working'].filter(
    (word): word is string => Boolean(word),
  );
  if (harm.length) {
    const label = harm.join(', ');
    marks.push({ kind: 'damaged', label: label.charAt(0).toUpperCase() + label.slice(1) });
  } else if (damageOf(side) === false) {
    marks.push({ kind: 'good', label: 'Good' });
  }
  if (side.clean === false) marks.push({ kind: 'dirty', label: 'Dirty' });
  if (!marks.length)
    marks.push(side.clean === true ? { kind: 'good', label: 'Clean' } : { kind: 'none', label: 'Not checked' });
  return marks;
}

/**
 * One side's grades in a few words: "Damaged, not working · dirty", "Good",
 * "Not checked". The console's comparison table reads the same, with its own
 * word for an item nobody graded.
 */
export function comparisonGradeText(side: AdminComparisonItemSide | null, empty = 'Not checked') {
  if (!side) return empty;
  const marks = comparisonMarks(side);
  if (marks.length === 1 && marks[0].kind === 'none') return empty;
  const text = marks.map((mark) => mark.label.toLowerCase()).join(' · ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "Doors and locks, Walls and ceilings and 2 more" */
function nameList(labels: readonly string[], most = 6) {
  if (labels.length <= most) return labels.join(', ');
  return `${labels.slice(0, most).join(', ')} and ${labels.length - most} more`;
}

/** "1 item" / "8 items" */
function itemCount(count: number) {
  return `${count} ${count === 1 ? 'item' : 'items'}`;
}

function roomCount(count: number) {
  return `${count} ${count === 1 ? 'room' : 'rooms'}`;
}

/** "was" or "were", "is" or "are", by count. */
function verb(count: number, one: string, many: string) {
  return count === 1 ? one : many;
}

export interface ComparisonGradeView {
  marks: ComparisonMark[];
  /** What the technician wrote on the item. */
  comment: string | null;
}

export interface ComparisonItemRowView {
  id: string;
  label: string;
  moveIn: ComparisonGradeView;
  moveOut: ComparisonGradeView;
  /** What happened to it: "New damage", "Fixed since move-in"; null when nothing did. */
  result: { label: string; tone: ReportTone; toneName: ComparisonToneName } | null;
  /** Dirty at move-out and not at move-in. */
  needsCleaning: boolean;
  /** Shown in the room. The rest -- nothing changed, nothing to do -- fold into one line. */
  changed: boolean;
}

export interface ComparisonFindingView {
  id: string;
  title: string;
  description: string;
  severityLabel: string;
  tone: ReportTone;
  toneName: ComparisonToneName;
}

/** One graded row of one side, for a room not compared item by item. */
export interface ComparisonChecklistRowView {
  id: string;
  label: string;
  marks: ComparisonMark[];
  comment: string;
}

export interface ComparisonSideView {
  /** False when this inspection has no such room. */
  present: boolean;
  /** The room as this inspection names it. */
  name: string | null;
  /** Named differently from the row: the reader should see both names. */
  renamed: boolean;
  statusLabel: string;
  /** Skipped on the day: its reason says everything, with nothing else to show. */
  skipped: boolean;
  skipReason: string | null;
  photos: ReportPhotoView[];
  findings: ComparisonFindingView[];
  /** This side's graded rows: shown for a room with no item table, and for one not compared. */
  checklist: ComparisonChecklistRowView[];
}

/** How many of a room's items came out which way. */
export interface ComparisonRoomCounts {
  /** Good at move-in, damaged now. */
  fresh: number;
  /** Confirmed by the office from the move-out recording. */
  confirmed: number;
  /** Damaged now, not checked at move-in. */
  undated: number;
  cleaning: number;
}

export interface ComparisonRoomView {
  id: string;
  name: string;
  /** The floor, when the property has one worth naming. */
  floorName: string | null;
  verdict: string;
  tone: ReportTone;
  toneName: ComparisonToneName;
  /** The sign beside the room in the list of rooms. */
  mark: ComparisonMarkKind;
  /** New damage or worse. */
  newDamage: boolean;
  /** What the two inspections recorded, in a sentence or two. */
  sentence: string | null;
  /** The room in the list of rooms: "8 damaged · 8 to clean". */
  digest: string;
  counts: ComparisonRoomCounts;
  items: ComparisonItemRowView[];
  /** The items not shown, in a line: "Doors and locks unchanged." Null when none. */
  folded: string | null;
  foldedCount: number;
  /**
   * What is new since move-in: the checklist items, then what the office
   * confirmed from the move-out recording.
   */
  newItems: string[];
  /** Labels of the items that need cleaning. */
  cleaningItems: string[];
  moveIn: ComparisonSideView;
  moveOut: ComparisonSideView;
}

/** A room only one inspection has, or one not inspected at move-out. */
export interface ComparisonUncomparedRoomView {
  id: string;
  name: string;
  /** "Only in the move-out inspection", "Skipped at move-out: Locked". */
  reason: string;
  /** Which inspection's record is summed up. */
  recordedAt: 'Move-in' | 'Move-out';
  /** "4 of 5 items damaged, 4 dirty", "All 5 items good", "Nothing graded". */
  recorded: string;
  mark: ComparisonMarkKind;
  /** The side summed up: its checklist and photographs, for a closer look. */
  side: ComparisonSideView;
}

/** One line of the box the report opens on. */
export interface ComparisonFoundView {
  mark: ComparisonMarkKind;
  /** The figure, in bold: "New damage in 12 rooms." */
  lead: string;
  /** The rest of the line. */
  detail: string;
}

export interface ComparisonView {
  brand: ComparisonReport['brand'];
  kicker: string;
  title: string;
  subtitle: string;
  moveIn: { label: string; date: string; inspector: string };
  moveOut: { label: string; date: string; inspector: string };
  headline: string;
  /** What was found, a line each: new damage, cleaning, what could not be dated or compared. */
  found: ComparisonFoundView[];
  key: readonly ComparisonMark[];
  /** The rooms both inspections have, in the office's order. */
  rooms: ComparisonRoomView[];
  /** The rest, listed at the end. */
  uncompared: ComparisonUncomparedRoomView[];
  disclaimer: string;
  generatedLabel: string;
}

/**
 * What the report is, said truthfully (2026-10-07): nobody approves a verdict
 * any more. Each comes from the two checklists the technicians recorded and
 * the findings the office confirmed from the move-out recordings -- the only
 * findings printed.
 */
const DISCLAIMER =
  'This report sets the condition recorded at the move-in inspection beside the condition ' +
  'recorded at move-out, room by room. Each verdict is drawn from the checklists the ' +
  'inspectors recorded and from findings the TexasRenters team confirmed from the move-out ' +
  'recordings, which are the only findings shown. It is informational: it does not by itself ' +
  'authorize charges or determine responsibility for any condition described.';

function checklistRows(side: ComparisonReportAreaSide): ComparisonChecklistRowView[] {
  return side.checklist
    .filter((item) => item.isClean !== null || item.isUndamaged !== null || item.isWorking !== null)
    .map((item) => ({
      id: item.id,
      label: item.label,
      marks: comparisonMarks({ clean: item.isClean, undamaged: item.isUndamaged, working: item.isWorking }),
      comment: item.comment?.trim() ?? '',
    }));
}

function sideView(
  side: ComparisonReportAreaSide | null,
  rowName: string,
  absent: string,
): ComparisonSideView {
  if (!side)
    return {
      present: false,
      name: null,
      renamed: false,
      statusLabel: absent,
      skipped: false,
      skipReason: null,
      photos: [],
      findings: [],
      checklist: [],
    };
  return {
    present: true,
    name: side.name,
    renamed: side.name.trim().toLowerCase() !== rowName.trim().toLowerCase(),
    statusLabel: ROOM_STATUS[side.completionStatus] ?? formatEnumLabel(side.completionStatus),
    skipped: side.completionStatus === 'SKIPPED',
    skipReason: side.skipReason?.trim() || null,
    photos: side.photos.map(reportPhotoView),
    findings: side.findings.map((finding) => {
      const severity = SEVERITY[finding.severity] ?? SEVERITY.LOW;
      return {
        id: finding.id,
        title: finding.title,
        description: finding.description,
        severityLabel: severity.label,
        tone: COMPARISON_TONE[severity.tone],
        toneName: severity.tone,
      };
    }),
    checklist: checklistRows(side),
  };
}

function itemRow(item: ComparisonReportItem): ComparisonItemRowView {
  // "No change" -- and "good at move-out" against a move-in that never graded
  // the item -- is nothing to report.
  const result = RESULT[item.change] ?? null;
  const needsCleaning = item.cleaning === 'NEEDS_CLEANING';
  return {
    id: item.itemId,
    label: item.label,
    moveIn: { marks: comparisonMarks(item.moveIn), comment: item.moveIn?.comment?.trim() || null },
    moveOut: { marks: comparisonMarks(item.moveOut), comment: item.moveOut?.comment?.trim() || null },
    result: result
      ? { label: result.label, tone: COMPARISON_TONE[result.tone], toneName: result.tone }
      : null,
    needsCleaning,
    changed: Boolean(result) || needsCleaning,
  };
}

/** The items not shown, in a line: "Doors and locks unchanged. Windows and locks not checked at move-out." */
function foldedLine(items: ComparisonReportItem[]) {
  const groups: Array<[string, string[]]> = [
    ['unchanged', []],
    ['good at move-out, not checked at move-in', []],
    ['not checked at move-out', []],
  ];
  for (const item of items) {
    if (item.change === 'NOT_GRADED') groups[2][1].push(item.label);
    else if (damageOf(item.moveIn) === null) groups[1][1].push(item.label);
    else groups[0][1].push(item.label);
  }
  const sentences = groups
    .filter(([, labels]) => labels.length)
    .map(([words, labels]) => `${nameList(labels)} ${words}.`);
  return sentences.length ? sentences.join(' ') : null;
}

/** What the office confirmed from the move-out recording, said once. */
function recordingSentence(area: ComparisonReportArea, alsoNew: boolean) {
  const titles = area.fromRecording ?? [];
  if (!titles.length) return null;
  if (area.classification === 'WORSENED')
    return `Our team confirmed from the move-out video that ${verb(titles.length, 'this is', 'these are')} worse than at move-in: ${nameList(titles)}.`;
  return `Our team ${alsoNew ? 'also ' : ''}confirmed from the move-out video: ${nameList(titles)}.`;
}

function countsOf(area: ComparisonReportArea, items: ComparisonReportItem[]): ComparisonRoomCounts {
  const count = (change: ComparisonItemChange) => items.filter((item) => item.change === change).length;
  return {
    fresh: count('NEW_DAMAGE'),
    confirmed: area.fromRecording?.length ?? 0,
    undated: count('NO_BASELINE'),
    cleaning: items.filter((item) => item.cleaning === 'NEEDS_CLEANING').length,
  };
}

/** A room compared item by item, in plain words. */
function itemizedSentence(area: ComparisonReportArea, items: ComparisonReportItem[]) {
  const { fresh, undated, cleaning } = countsOf(area, items);
  const existing = items.filter((item) => item.change === 'ALREADY_DAMAGED').length;
  const repaired = items.filter((item) => item.change === 'REPAIRED').length;

  const sentences: string[] = [];
  if (fresh)
    sentences.push(
      `${itemCount(fresh)} ${verb(fresh, 'was', 'were')} in good condition at move-in and ${verb(fresh, 'is', 'are')} damaged now.`,
    );
  const recording = recordingSentence(area, fresh > 0);
  if (recording) sentences.push(recording);
  if (undated)
    sentences.push(
      `${itemCount(undated)} damaged at move-out ${verb(undated, 'was', 'were')} not checked at move-in, so we can't tell whether ${verb(undated, 'it is', 'they are')} new.`,
    );
  if (existing) sentences.push(`${itemCount(existing)} ${verb(existing, 'was', 'were')} already damaged at move-in.`);
  if (repaired)
    sentences.push(`${itemCount(repaired)} damaged at move-in ${verb(repaired, 'is', 'are')} in good condition now.`);
  if (!sentences.length) sentences.push('Nothing is in worse condition than at move-in.');
  if (cleaning) sentences.push(`${itemCount(cleaning)} ${verb(cleaning, 'needs', 'need')} cleaning.`);
  return sentences.join(' ');
}

/**
 * A compared room the checklists could not compare item by item, in plain
 * words. Worded here rather than read from the comparison, so a comparison
 * drawn under older rules -- whose sentences were written for a reviewer --
 * prints the same as a new one.
 */
function sentenceWithoutItems(area: ComparisonReportArea, moveIn: ComparisonSideView) {
  const recording = recordingSentence(area, false);
  switch (area.classification) {
    case 'NOT_COMPARABLE':
      return moveIn.present && !moveIn.checklist.length
        ? "Damage was recorded at move-out, but the move-in recorded no condition for this room, so we can't tell whether it is new."
        : "Damage was recorded at both inspections, but not on the same items, so we can't tell what is new.";
    case 'NEW_DAMAGE':
      return ['The move-out recorded damage here that the move-in did not.', recording].filter(Boolean).join(' ');
    case 'WORSENED':
      return recording ?? 'Worse than at move-in.';
    case 'UNCHANGED':
      return 'No new damage was recorded at move-out.';
    case 'RESOLVED':
    case 'IMPROVED':
      return 'Damage recorded at move-in was not recorded at move-out.';
    default:
      return null;
  }
}

function roomView(area: ComparisonReportArea): ComparisonRoomView {
  const verdict = verdictOf(area.classification);
  const items = area.items ?? [];
  const moveIn = sideView(area.moveIn, area.areaName, 'Not in the move-in inspection');
  const moveOut = sideView(area.moveOut, area.areaName, 'Not in the move-out inspection');
  // Compared item by item when some item was graded on both sides.
  const itemized = items.some(
    (item) => damageOf(item.moveIn) !== null && damageOf(item.moveOut) !== null,
  );
  const newDamage = area.classification === 'NEW_DAMAGE' || area.classification === 'WORSENED';
  const rows = items.map(itemRow);
  const quiet = items.filter((_, index) => !rows[index].changed);
  const counts = countsOf(area, items);
  const newItems = [
    ...items.filter((item) => item.change === 'NEW_DAMAGE').map((item) => item.label),
    ...(area.fromRecording ?? []),
  ];
  const cleaningItems = items
    .filter((item) => item.cleaning === 'NEEDS_CLEANING')
    .map((item) => item.label);

  const condition = newDamage
    ? newItems.length
      ? `${newItems.length} damaged`
      : 'New damage'
    : verdict.label;
  const floor = area.floorName?.trim() || null;
  return {
    id: area.id,
    name: area.areaName,
    floorName: floor && !ADDED_AREAS.test(floor) ? floor : null,
    verdict: verdict.label,
    tone: COMPARISON_TONE[verdict.tone],
    toneName: verdict.tone,
    mark: verdict.mark,
    newDamage,
    sentence: itemized ? itemizedSentence(area, items) : sentenceWithoutItems(area, moveIn),
    digest: [condition, cleaningItems.length ? `${cleaningItems.length} to clean` : null]
      .filter(Boolean)
      .join(' · '),
    counts,
    items: rows,
    folded: foldedLine(quiet),
    foldedCount: quiet.length,
    newItems,
    cleaningItems,
    moveIn,
    moveOut,
  };
}

/** A side's record in a phrase: "4 of 5 items damaged, 4 dirty". */
function recordedPhrase(side: ComparisonSideView): { text: string; mark: ComparisonMarkKind } {
  if (side.skipped) return { text: side.skipReason ? `Skipped: ${side.skipReason}` : 'Skipped', mark: 'none' };
  const rows = side.checklist;
  if (!rows.length) return { text: side.photos.length ? 'Photographs only' : 'Nothing graded', mark: 'none' };
  const damaged = rows.filter((row) => row.marks.some((mark) => mark.kind === 'damaged')).length;
  const dirty = rows.filter((row) => row.marks.some((mark) => mark.kind === 'dirty')).length;
  if (!damaged && !dirty)
    return { text: rows.length === 1 ? 'Its 1 item good' : `All ${rows.length} items good`, mark: 'good' };
  const parts = [
    damaged ? `${damaged} of ${itemCount(rows.length)} damaged` : null,
    dirty ? (damaged ? `${dirty} dirty` : `${dirty} of ${itemCount(rows.length)} dirty`) : null,
  ];
  return { text: parts.filter(Boolean).join(', '), mark: damaged ? 'damaged' : 'dirty' };
}

function uncomparedView(area: ComparisonReportArea): ComparisonUncomparedRoomView {
  const moveIn = sideView(area.moveIn, area.areaName, 'Not in the move-in inspection');
  const moveOut = sideView(area.moveOut, area.areaName, 'Not in the move-out inspection');
  let reason: string;
  if (area.classification === 'MISSING_BASELINE') reason = 'Only in the move-out inspection';
  else if (!moveOut.present) reason = 'Only in the move-in inspection';
  else if (moveOut.skipped)
    reason = moveOut.skipReason ? `Skipped at move-out: ${moveOut.skipReason}` : 'Skipped at move-out';
  else reason = 'No photographs or video taken at move-out';
  // The record there is: the move-out's for a room only it has, else the move-in's.
  const fromMoveOut = area.classification === 'MISSING_BASELINE' || !moveIn.present;
  const side = fromMoveOut ? moveOut : moveIn;
  const recorded = recordedPhrase(side);
  return {
    id: area.id,
    name: area.areaName,
    reason,
    recordedAt: fromMoveOut ? 'Move-out' : 'Move-in',
    recorded: recorded.text,
    mark: recorded.mark,
    side,
  };
}

function sideHeader(side: ComparisonReport['moveIn'], fallback: string) {
  const completed = formatReportDay(side.completedAt, true);
  const scheduled = formatReportDay(side.scheduledAt);
  return {
    label: side.templateLabel?.trim() || fallback,
    date: completed ? `Completed ${completed}` : scheduled ? `Scheduled ${scheduled}` : 'Date not recorded',
    inspector: side.inspector?.trim() ?? '',
  };
}

/** The box the report opens on: what was found, a line each. */
function foundLines(compared: ComparisonRoomView[], uncompared: ComparisonUncomparedRoomView[]) {
  const found: ComparisonFoundView[] = [];
  // Counted in the rooms whose verdict is new damage, so the figure and the
  // rooms listed beneath it always agree.
  const damaged = compared.filter((room) => room.newDamage);
  const fresh = damaged.reduce((total, room) => total + room.counts.fresh, 0);
  const confirmed = damaged.reduce((total, room) => total + room.counts.confirmed, 0);
  if (damaged.length) {
    const details = [
      fresh
        ? `${itemCount(fresh)} ${verb(fresh, 'was', 'were')} in good condition at move-in and ${verb(fresh, 'is', 'are')} damaged now.`
        : null,
      confirmed
        ? `Our team ${fresh ? 'also ' : ''}confirmed ${confirmed} ${verb(confirmed, 'issue', 'issues')} from the move-out video.`
        : null,
    ];
    found.push({
      mark: 'damaged',
      lead: `New damage in ${roomCount(damaged.length)}.`,
      detail: details.filter(Boolean).join(' '),
    });
  } else {
    found.push({
      mark: 'good',
      lead: 'No new damage.',
      detail: 'Nothing in good condition at move-in was recorded as damaged at move-out.',
    });
  }

  const cleaningRooms = compared.filter((room) => room.counts.cleaning);
  const cleaning = cleaningRooms.reduce((total, room) => total + room.counts.cleaning, 0);
  if (cleaning)
    found.push({
      mark: 'dirty',
      lead: `${itemCount(cleaning)} ${verb(cleaning, 'needs', 'need')} cleaning`,
      detail: `in ${roomCount(cleaningRooms.length)}.`,
    });

  const undated = compared.reduce((total, room) => total + room.counts.undated, 0);
  if (undated)
    found.push({
      mark: 'none',
      lead: `${itemCount(undated)} can't be dated.`,
      detail: `${verb(undated, 'It was', 'They were')} damaged at move-out but not checked at move-in.`,
    });

  if (uncompared.length)
    found.push({
      mark: 'none',
      lead: `${roomCount(uncompared.length)} couldn't be compared.`,
      detail: `${verb(uncompared.length, 'It was', 'They were')} recorded at only one of the two inspections, and ${verb(uncompared.length, 'is', 'are')} listed at the end.`,
    });
  return found;
}

export function buildComparisonView(report: ComparisonReport): ComparisonView {
  const compared = report.areas.filter((area) => !NOT_COMPARED.has(area.classification)).map(roomView);
  const uncompared = report.areas
    .filter((area) => NOT_COMPARED.has(area.classification))
    .map(uncomparedView);
  const damaged = compared.filter((room) => room.newDamage).length;

  const property = report.property;
  const unit = property.unitName ? `, Unit ${property.unitName}` : '';

  return {
    brand: report.brand,
    kicker: 'Move-in / move-out comparison',
    title: `${property.addressLine1 || property.name}${unit}`,
    subtitle: [property.city, property.state, property.postalCode].filter(Boolean).join(', '),
    moveIn: sideHeader(report.moveIn, 'Move-in inspection'),
    moveOut: sideHeader(report.moveOut, 'Move-out inspection'),
    headline: damaged ? `New damage in ${roomCount(damaged)}` : 'No new damage recorded at move-out',
    found: foundLines(compared, uncompared),
    key: COMPARISON_KEY,
    rooms: compared,
    uncompared,
    disclaimer: DISCLAIMER,
    generatedLabel: formatReportDay(report.generatedAt, true) ?? '',
  };
}

/** "Doors and locks, Walls and ceilings and 2 more", for a summary line. */
export const comparisonItemList = nameList;
