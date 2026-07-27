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
import type { PublicInspectionReport, PublicReportPhoto } from '../contracts/admin.js';

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

function formatDay(value?: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

/** Photo captions carry a capture time, matching the legacy report's stamps. */
function formatStamp(value?: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(date);
}

export interface ReportPhotoView {
  id: string;
  caption: string | null;
  notes: string | null;
  stamp: string | null;
  contentPath: string;
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

export interface ReportRoomView {
  id: string;
  name: string;
  floorName: string | null;
  statusLabel: string;
  /** True only for COMPLETED, so renderers can accent inspected rooms. */
  inspected: boolean;
  skipReason: string | null;
  photos: ReportPhotoView[];
  findings: ReportFindingView[];
  /** False when the room has neither photos nor findings — render it compactly. */
  hasEvidence: boolean;
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

const DISCLAIMER =
  'Every finding in this report was reviewed and approved by the TexasRenters team before ' +
  'publication. This report is informational: it does not by itself authorize charges or ' +
  'determine responsibility for any condition described.';

function mapPhoto(photo: PublicReportPhoto): ReportPhotoView {
  return {
    id: photo.id,
    caption: photo.label?.trim() || null,
    notes: photo.notes?.trim() || null,
    stamp: formatStamp(photo.capturedAt),
    contentPath: photo.contentPath,
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
    if (list) list.push(mapPhoto(photo));
    else photosByRoom.set(photo.roomId, [mapPhoto(photo)]);
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

  const rooms: ReportRoomView[] = report.rooms.map((room) => {
    const photos = photosByRoom.get(room.id) ?? [];
    const roomFindings = (findingsByRoom.get(room.id) ?? []).sort(bySeverity);
    return {
      id: room.id,
      name: room.name,
      floorName: room.floorName ?? null,
      statusLabel: ROOM_STATUS_LABEL[room.completionStatus] ?? formatEnumLabel(room.completionStatus),
      inspected: room.completionStatus === 'COMPLETED',
      skipReason: room.skipReason?.trim() || null,
      photos,
      findings: roomFindings,
      hasEvidence: photos.length > 0 || roomFindings.length > 0,
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
  const completed = formatDay(report.inspection.completedAt);
  const scheduled = formatDay(report.inspection.scheduledAt);

  return {
    brand: report.brand,
    title: `${property.addressLine1 || property.name}${unit}`,
    subtitle: [property.city, property.state, property.postalCode].filter(Boolean).join(', '),
    inspectionLabel: `${formatEnumLabel(report.inspection.type)} inspection`,
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
    generatedLabel: formatDay(report.generatedAt) ?? '',
    disclaimer: DISCLAIMER,
  };
}
