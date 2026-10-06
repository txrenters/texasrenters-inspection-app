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

/** Each verdict, worded for the owner or tenant reading it. */
const VERDICT: Record<string, { label: string; tone: ComparisonToneName }> = {
  NEW_DAMAGE: { label: 'New damage', tone: 'damage' },
  WORSENED: { label: 'Worse than at move-in', tone: 'damage' },
  UNCHANGED: { label: 'No new damage', tone: 'sound' },
  IMPROVED: { label: 'Better than at move-in', tone: 'sound' },
  RESOLVED: { label: 'Better than at move-in', tone: 'sound' },
  MISSING_BASELINE: { label: 'Not recorded at move-in', tone: 'neutral' },
  MISSING_MOVE_OUT_EVIDENCE: { label: 'Not inspected at move-out', tone: 'neutral' },
  // Damage the record cannot call new or old: its sentence says why.
  NOT_COMPARABLE: { label: 'Cannot be compared', tone: 'neutral' },
  // No longer drawn (2026-10-07); a comparison still holding one is redrawn
  // before it is read.
  REQUIRES_REVIEW: { label: 'Under review', tone: 'neutral' },
};

function verdictOf(classification: string) {
  return VERDICT[classification] ?? { label: formatEnumLabel(classification), tone: 'neutral' as const };
}

/** What happened to one item, in words. */
const CHANGE: Record<ComparisonItemChange, { label: string; tone: ComparisonToneName }> = {
  NEW_DAMAGE: { label: 'New since move-in', tone: 'damage' },
  NO_BASELINE: { label: 'Not recorded at move-in', tone: 'neutral' },
  ALREADY_DAMAGED: { label: 'Already at move-in', tone: 'neutral' },
  REPAIRED: { label: 'Repaired', tone: 'sound' },
  NO_CHANGE: { label: 'No change', tone: 'sound' },
  NOT_GRADED: { label: 'Not checked at move-out', tone: 'neutral' },
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

/** Damaged or not working: true; graded sound: false; not graded for damage: null. */
function damageOf(side: AdminComparisonItemSide | null) {
  if (!side) return null;
  if (side.undamaged === false || side.working === false) return true;
  if (side.undamaged === true || side.working === true) return false;
  return null;
}

/**
 * One side's grades in a few words: "Damaged, not working · dirty", "Sound",
 * "Not checked". The console's comparison table reads the same, with its own
 * word for an item nobody graded.
 */
export function comparisonGradeText(side: AdminComparisonItemSide | null, empty = 'Not checked') {
  if (!side) return empty;
  const condition: string[] = [];
  if (side.undamaged === false) condition.push('damaged');
  if (side.working === false) condition.push('not working');
  if (!condition.length && (side.undamaged === true || side.working === true))
    condition.push('sound');
  const cleanliness =
    side.clean === false ? 'dirty' : side.clean === true && !condition.length ? 'clean' : null;
  const text = [condition.join(', '), cleanliness].filter(Boolean).join(' · ');
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : empty;
}

/**
 * An item's change, named. "No change" claims the move-in recorded the item
 * sound, so an item the move-in never graded says only what the move-out saw.
 */
export function comparisonChange(item: Pick<ComparisonReportItem, 'change' | 'moveIn'>) {
  const change = CHANGE[item.change];
  if (item.change === 'NO_CHANGE' && damageOf(item.moveIn) === null)
    return { label: 'Sound at move-out', tone: 'sound' as const };
  return change;
}

/** "Doors and locks, Walls and ceilings and 2 more" */
function nameList(labels: readonly string[], most = 6) {
  if (labels.length <= most) return labels.join(', ');
  return `${labels.slice(0, most).join(', ')} and ${labels.length - most} more`;
}

export interface ComparisonItemRowView {
  id: string;
  label: string;
  moveIn: string;
  moveOut: string;
  /** What the technician wrote on the item, each side. */
  moveInComment: string | null;
  moveOutComment: string | null;
  change: string;
  changeTone: ReportTone;
  /** "Needs cleaning", or "Not clean at move-in either"; null when clean. */
  cleaning: string | null;
  cleaningTone: ReportTone;
  /** Printed quieter: nothing changed and nothing needs doing. */
  quiet: boolean;
}

export interface ComparisonFindingView {
  id: string;
  title: string;
  description: string;
  severityLabel: string;
  tone: ReportTone;
}

/** One condition row of one side, for a room compared without items. */
export interface ComparisonChecklistRowView {
  id: string;
  label: string;
  /** "Y", "N", or empty for not assessed -- never "N" for a blank. */
  clean: string;
  undamaged: string;
  working: string;
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
  /** This side's graded rows, shown only when the room has no item table. */
  checklist: ComparisonChecklistRowView[];
}

export interface ComparisonRoomView {
  id: string;
  name: string;
  floorName: string | null;
  verdict: string;
  tone: ReportTone;
  /** New damage or worse: what the summary lists. */
  newDamage: boolean;
  /** What the two inspections recorded, in a sentence or two. */
  sentence: string | null;
  items: ComparisonItemRowView[];
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

export interface ComparisonStatView {
  label: string;
  value: number;
  tone: ReportTone;
}

export interface ComparisonView {
  brand: ComparisonReport['brand'];
  kicker: string;
  title: string;
  subtitle: string;
  moveIn: { label: string; date: string; inspector: string };
  moveOut: { label: string; date: string; inspector: string };
  headline: string;
  stats: ComparisonStatView[];
  /** Rooms with new damage, and what is new in each. */
  newDamage: Array<{ id: string; name: string; items: string[] }>;
  /** Rooms with something to clean, and what. */
  cleaning: Array<{ id: string; name: string; items: string[] }>;
  rooms: ComparisonRoomView[];
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

function axisCell(value: boolean | null | undefined) {
  if (value === true) return 'Y';
  if (value === false) return 'N';
  return '';
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
      };
    }),
    checklist: side.checklist
      .filter((item) => item.isClean !== null || item.isUndamaged !== null || item.isWorking !== null)
      .map((item) => ({
        id: item.id,
        label: item.label,
        clean: axisCell(item.isClean),
        undamaged: axisCell(item.isUndamaged),
        working: axisCell(item.isWorking),
        comment: item.comment?.trim() ?? '',
      })),
  };
}

/**
 * What the record says about a room the checklists could not compare item by
 * item, in plain words. Worded here rather than read from the comparison, so a
 * comparison drawn under older rules -- whose sentences were written for a
 * reviewer -- prints the same as a new one.
 */
function sentenceWithoutItems(area: ComparisonReportArea, moveOut: ComparisonSideView) {
  switch (area.classification) {
    case 'NOT_COMPARABLE':
      // Why it cannot be compared differs room by room; the comparison says.
      return area.summary.trim() || 'The two inspections did not record this room in a way that can be compared.';
    case 'MISSING_BASELINE':
      return 'The move-in inspection has no matching room, so there is nothing to compare it with.';
    case 'MISSING_MOVE_OUT_EVIDENCE':
      if (moveOut.skipReason) return `Not inspected at move-out: ${moveOut.skipReason}.`;
      return moveOut.present
        ? 'No photographs or recording of this room were taken at move-out.'
        : 'Recorded at move-in; this room was not part of the move-out inspection.';
    case 'NEW_DAMAGE':
      return 'Damage was recorded at move-out that the move-in did not record.';
    case 'UNCHANGED':
      return 'No new damage was recorded at move-out.';
    case 'RESOLVED':
    case 'IMPROVED':
      return 'A condition recorded at move-in was not recorded at move-out.';
    default:
      return null;
  }
}

function roomView(area: ComparisonReportArea): ComparisonRoomView {
  const verdict = verdictOf(area.classification);
  const items = area.items ?? [];
  const moveIn = sideView(area.moveIn, area.areaName, 'Not in the move-in inspection');
  const moveOut = sideView(area.moveOut, area.areaName, 'Not in the move-out inspection');
  // The stored sentence is the checklist's own words when the verdict was drawn
  // item by item -- when some item was graded on both sides.
  const itemized = items.some(
    (item) => damageOf(item.moveIn) !== null && damageOf(item.moveOut) !== null,
  );
  const sentence = itemized ? area.summary.trim() || null : sentenceWithoutItems(area, moveOut);

  const rows: ComparisonItemRowView[] = items.map((item) => {
    const change = comparisonChange(item);
    const cleaning =
      item.cleaning === 'NEEDS_CLEANING'
        ? 'Needs cleaning'
        : item.cleaning === 'ALREADY_DIRTY'
          ? 'Not clean at move-in either'
          : null;
    return {
      id: item.itemId,
      label: item.label,
      moveIn: comparisonGradeText(item.moveIn),
      moveOut: comparisonGradeText(item.moveOut),
      moveInComment: item.moveIn?.comment?.trim() || null,
      moveOutComment: item.moveOut?.comment?.trim() || null,
      change: change.label,
      changeTone: COMPARISON_TONE[change.tone],
      cleaning,
      cleaningTone: COMPARISON_TONE[item.cleaning === 'NEEDS_CLEANING' ? 'cleaning' : 'neutral'],
      quiet:
        (item.change === 'NO_CHANGE' || item.change === 'NOT_GRADED') &&
        item.cleaning !== 'NEEDS_CLEANING',
    };
  });

  return {
    id: area.id,
    name: area.areaName,
    floorName: area.floorName ?? null,
    verdict: verdict.label,
    tone: COMPARISON_TONE[verdict.tone],
    newDamage: area.classification === 'NEW_DAMAGE' || area.classification === 'WORSENED',
    sentence,
    items: rows,
    newItems: [
      ...items.filter((item) => item.change === 'NEW_DAMAGE').map((item) => item.label),
      ...(area.fromRecording ?? []),
    ],
    cleaningItems: items
      .filter((item) => item.cleaning === 'NEEDS_CLEANING')
      .map((item) => item.label),
    moveIn,
    moveOut,
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

export function buildComparisonView(report: ComparisonReport): ComparisonView {
  const rooms = report.areas.map(roomView);
  const newDamage = rooms
    .filter((room) => room.newDamage)
    .map((room) => ({ id: room.id, name: room.name, items: room.newItems }));
  const cleaning = rooms
    .filter((room) => room.cleaningItems.length)
    .map((room) => ({ id: room.id, name: room.name, items: room.cleaningItems }));
  // Counted in the rooms whose verdict is new damage, so the figure and the
  // list beneath it always agree.
  const newItems = newDamage.reduce((total, room) => total + room.items.length, 0);
  const cleaningItems = rooms.reduce((total, room) => total + room.cleaningItems.length, 0);

  const property = report.property;
  const unit = property.unitName ? `, Unit ${property.unitName}` : '';

  return {
    brand: report.brand,
    kicker: 'Move-in / move-out comparison',
    title: `${property.addressLine1 || property.name}${unit}`,
    subtitle: [property.city, property.state, property.postalCode].filter(Boolean).join(', '),
    moveIn: sideHeader(report.moveIn, 'Move-in inspection'),
    moveOut: sideHeader(report.moveOut, 'Move-out inspection'),
    headline: newDamage.length
      ? `New damage recorded in ${newDamage.length} ${newDamage.length === 1 ? 'room' : 'rooms'}`
      : 'No new damage recorded at move-out',
    stats: [
      { label: 'Rooms compared', value: rooms.length, tone: COMPARISON_TONE.neutral },
      {
        label: 'Rooms with new damage',
        value: newDamage.length,
        tone: COMPARISON_TONE[newDamage.length ? 'damage' : 'sound'],
      },
      {
        label: 'Items new since move-in',
        value: newItems,
        tone: COMPARISON_TONE[newItems ? 'damage' : 'sound'],
      },
      {
        label: 'Items needing cleaning',
        value: cleaningItems,
        tone: COMPARISON_TONE[cleaningItems ? 'cleaning' : 'sound'],
      },
    ],
    newDamage,
    cleaning,
    rooms,
    disclaimer: DISCLAIMER,
    generatedLabel: formatReportDay(report.generatedAt, true) ?? '',
  };
}

/** "Doors and locks, Walls and ceilings and 2 more", for a summary line. */
export const comparisonItemList = nameList;
