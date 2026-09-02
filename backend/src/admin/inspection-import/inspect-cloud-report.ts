/**
 * Reading an Inspect & Cloud property inspection report.
 *
 * Inspections done outside this app — by an agent, or before the handset
 * existed — arrive as a PDF. Without them a move-out has nothing to compare
 * against, because `ComparisonService.resolveBaseline` needs a *move-in* on the
 * same property to exist at all.
 *
 * Deterministic, and deliberately so. The report is a machine-generated table
 * drawn at fixed coordinates, so reading it needs no model: a parser can be
 * reviewed, produces the same answer twice, and costs nothing per page. It also
 * keeps a guess out of evidence that ends up justifying a charge against a
 * tenant, which is the rule the rest of this codebase holds AI to.
 *
 * Every constant below was measured from a real report rather than assumed —
 * see `inspect-cloud-report.spec.ts`, which parses a synthesised page built to
 * the same geometry.
 */
import { createHash } from 'node:crypto';

import { keywordsFromLabel, CHECKLIST_VOCABULARY } from '@texasrenters/shared';

/**
 * Column positions, in PDF points.
 *
 * The item label sits at x≈16, the three grades at 253/267/281, and a comment
 * from 293. Measured through pdf.js, which is what reads the file here — a
 * different library reports the same glyphs six points away because the two do
 * not share an origin, so a band lifted from one and used by the other misses
 * every grade while still producing a parse that looks complete.
 */
const COLUMN = {
  label: [0, 40],
  clean: [248, 259],
  undamaged: [262, 273],
  working: [276, 287],
  comment: [288, 1000],
} as const;

const inBand = (x: number, [low, high]: readonly [number, number]) => x >= low && x <= high;

/** Cells on the same visual row, allowing for sub-point jitter. */
const ROW_TOLERANCE = 2;
/** Wider than the space between words, narrower than the gap between columns. */
const CELL_GAP = 12;
/** Below this, a gap is a word broken across two runs rather than a space. */
const SPACE_GAP = 1.5;
/** The three grade columns are drawn on this pitch. */
const GRADE_PITCH = 14;
const GRADE_WIDTH = 7.3;

/**
 * Two or more grades pdf.js has run together, e.g. "Y N".
 *
 * It merges adjacent text of its own accord and there is no way to ask it not
 * to — `disableCombineTextItems` was removed in pdf.js 6 and passing it does
 * nothing — so the undamaged and working columns arrive as a single item. Left
 * alone, one grade is read, the other lost, and the comment beside them is
 * swept into the same cell.
 */
const GRADE_RUN = /^[YN](\s+[YN])+$/;
const TIMESTAMP = /^[A-Z][a-z]{2}\s+\d{1,2}\s+\d{4}\s+\d{1,2}:\d{2}:\d{2}\s+[AP]M$/;
const FOOTER = /^Page\s+\d+\s+of\s+\d+$/;
const REPORT_DATE = /^[A-Z]{3}-\d{2}-\d{4}$/;

/** Below this the match is reported but not trusted; a person confirms it. */
export const CONFIDENT_MATCH = 1;
/** Below this it is not a checklist row at all. */
const PLAUSIBLE_MATCH = 0.5;

export interface ReportCell {
  x: number;
  y: number;
  width: number;
  text: string;
  rotated: boolean;
}

export interface ImportedChecklistItem {
  sourceLabel: string;
  matchedLabel: string | null;
  matchScore: number;
  /** Null is not false: a blank row means the inspector did not assess it. */
  isClean: boolean | null;
  isUndamaged: boolean | null;
  isWorking: boolean | null;
  comment: string | null;
  assessed: boolean;
  page: number;
}

export interface ImportedPhoto {
  caption: string | null;
  matchedLabel: string | null;
  takenAt: string | null;
  page: number;
  /** Position within the page's draw order, which is how bytes are matched. */
  index: number;
}

export interface ImportedArea {
  name: string;
  startedOnPage: number;
  items: ImportedChecklistItem[];
  photos: ImportedPhoto[];
}

export interface ImportedReport {
  inspector: string | null;
  template: string | null;
  reportDate: string | null;
  pages: number;
  areas: ImportedArea[];
  /** Rows in the item column that are not checklist items. Never discarded. */
  unrecognised: Array<{ area: string; page: number; text: string }>;
}

interface Row {
  y: number;
  cells: Array<{ x: number; width: number; text: string }>;
}

const VOCABULARY = CHECKLIST_VOCABULARY.map((label) => ({
  label,
  keywords: new Set(keywordsFromLabel(label)),
}));

/**
 * The template item a report label is naming, and how sure that is.
 *
 * Matched on keywords through the app's own `keywordsFromLabel`, so an imported
 * item resolves exactly as the same words typed by an administrator would. A
 * second normaliser here would drift from that one and tick under different
 * conditions.
 *
 * Scored rather than compared, because the source is not consistent with
 * itself — one page says "WALLS & CEILING" and another "WALLS & CEILINGS".
 * Most rows land on 1; the score exists for the ones that do not, like "BASIN,
 * CABINET VANITY & MIRROR" against "Basin, vanity and mirror", which is a real
 * match carrying a word the template lacks and should be imported *and*
 * flagged rather than silently attached or silently dropped.
 */
export function matchChecklistLabel(rawLabel: string): { label: string | null; score: number } {
  const keywords = new Set(keywordsFromLabel(rawLabel));
  if (!keywords.size) return { label: null, score: 0 };
  let best: { label: string | null; score: number } = { label: null, score: 0 };
  for (const entry of VOCABULARY) {
    let shared = 0;
    for (const word of keywords) if (entry.keywords.has(word)) shared += 1;
    const union = new Set([...keywords, ...entry.keywords]).size;
    const score = union ? shared / union : 0;
    if (score > best.score) best = { label: entry.label, score: Number(score.toFixed(3)) };
  }
  return best;
}

/**
 * Text runs regrouped into the table cells they were drawn as.
 *
 * Rows come from clustering on y; cells from the gap between runs. Grades are
 * split back out first, because pdf.js has already merged them and no gap
 * survives to separate them by.
 */
export function toRows(cells: readonly ReportCell[]): Row[] {
  const expanded: Array<{ x: number; y: number; width: number; text: string }> = [];
  for (const cell of cells) {
    // The column headers are drawn on a slant, and they sit above the first
    // area's title — left in, "Clean Undamaged Working" is read as the name of
    // the first room.
    if (cell.rotated) continue;
    if (GRADE_RUN.test(cell.text)) {
      const grades = cell.text.split(/\s+/);
      grades.forEach((text, position) =>
        expanded.push({
          x: Math.round(cell.x + position * GRADE_PITCH),
          y: cell.y,
          width: GRADE_WIDTH,
          text,
        }),
      );
      continue;
    }
    expanded.push({ x: Math.round(cell.x), y: cell.y, width: cell.width, text: cell.text });
  }

  const rows: Array<{ y: number; runs: typeof expanded }> = [];
  for (const cell of [...expanded].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const row = rows.find((candidate) => Math.abs(candidate.y - cell.y) <= ROW_TOLERANCE);
    if (row) row.runs.push(cell);
    else rows.push({ y: cell.y, runs: [cell] });
  }

  return rows.map((row) => {
    row.runs.sort((a, b) => a.x - b.x);
    const merged: Row['cells'] = [];
    for (const run of row.runs) {
      const last = merged[merged.length - 1];
      const isGrade = (text: string) => text === 'Y' || text === 'N';
      const atomic = isGrade(run.text) || (last !== undefined && isGrade(last.text));
      const gap = last ? run.x - (last.x + last.width) : Number.POSITIVE_INFINITY;
      if (last && !atomic && gap <= CELL_GAP) {
        // Whether the join needs a space is a question about the gap. This
        // generator breaks runs mid-word — a name is drawn as "Amy Wilso n" —
        // so joining every run with a space corrupts the words it repairs.
        last.text = gap > SPACE_GAP ? `${last.text} ${run.text}` : `${last.text}${run.text}`;
        last.width = run.x + run.width - last.x;
      } else merged.push({ x: run.x, width: run.width, text: run.text });
    }
    return { y: row.y, cells: merged };
  });
}

/**
 * A row of photograph captions rather than a row of the table.
 *
 * Two or more cells, none of them a grade, none at the far left. A checklist
 * row is one label plus its grades and at most one comment, and a wrapped
 * comment line is a single cell — so nothing in the table looks like this.
 *
 * Position alone does not separate them. Captions are centred under their
 * thumbnail, so a long one such as "BASIN, CABINET VANITY & MIRROR" starts far
 * enough left to sit in the item column, and was read as an extra checklist
 * item carrying the caption beside it as its comment.
 */
const looksLikeCaptions = (row: Row) =>
  row.cells.length >= 2 &&
  row.cells.every(
    (cell) =>
      cell.x >= 20 &&
      !inBand(cell.x, COLUMN.clean) &&
      !inBand(cell.x, COLUMN.undamaged) &&
      !inBand(cell.x, COLUMN.working),
  );

const gradeAt = (row: Row, band: readonly [number, number]) => {
  const cell = row.cells.find((entry) => inBand(entry.x, band));
  if (!cell) return null;
  if (cell.text === 'Y') return true;
  if (cell.text === 'N') return false;
  return null;
};

/**
 * One page's rows, in reading order.
 *
 * pdf.js reports each page in its own user space where y increases upward, so
 * descending y is top to bottom. Nothing here infers the direction: an earlier
 * version did, from coordinates a different library reported as accumulating
 * across pages, and the inference it justified read the first checklist row as
 * the name of the area.
 */
const readingOrder = (rows: Row[]) => [...rows].sort((a, b) => b.y - a.y);

export function parseReport(pages: Array<{ number: number; cells: ReportCell[] }>): ImportedReport {
  const areas: ImportedArea[] = [];
  const unrecognised: ImportedReport['unrecognised'] = [];
  const meta: { inspector: string | null; template: string | null; reportDate: string | null } = {
    inspector: null,
    template: null,
    reportDate: null,
  };
  let current: ImportedArea | null = null;
  let pendingHeaderLabels: Array<{ x: number; key: 'inspector' | 'template' }> | null = null;

  for (const page of pages) {
    const rows = readingOrder(toRows(page.cells));
    const headerIndex = rows.findIndex((row) => row.cells.some((c) => c.text === 'ROOM/ITEM'));

    /**
     * Where the grid stops.
     *
     * At the *last* row carrying an item label, not the first row without one
     * and not the first row of capture times. Both of those are wrong for the
     * same reason: rows belonging to the table do not all carry a label.
     *
     * A comment too long for its column wraps onto its own rows, which sit in
     * the comment column with nothing beside them and straddle the row they
     * describe — one line above the item, one below. Stopping at the first
     * label-less row throws that area away entirely. Stopping at the first
     * capture time instead keeps the caption row that sits just above it,
     * which is not table at all.
     */
    const firstTimestampRow = rows.findIndex(
      (row, index) =>
        index > headerIndex &&
        row.cells.length > 0 &&
        row.cells.every((c) => TIMESTAMP.test(c.text)),
    );
    const photosBegin = firstTimestampRow === -1 ? rows.length : firstTimestampRow;
    let tableEnds = headerIndex;
    if (headerIndex !== -1)
      for (let i = headerIndex + 1; i < photosBegin; i += 1)
        if (rows[i]!.cells.some((c) => inBand(c.x, COLUMN.label)) && !looksLikeCaptions(rows[i]!))
          tableEnds = i;

    const wrappedComments: Array<{ y: number; text: string }> = [];
    const itemRows: Array<{ y: number; item: ImportedChecklistItem }> = [];
    // Carried with the area that was open when the row was read. An area's
    // photographs run past the page break, so on a page where the next area
    // begins the pictures above its title still belong to the previous one --
    // attributing them at the end of the page gave them all to the new area.
    const captions: Array<{ text: string; column: number; y: number; area: ImportedArea }> = [];
    const captureTimes: Array<{ text: string; column: number; y: number; area: ImportedArea }> = [];

    for (const [index, row] of rows.entries()) {
      const { cells } = row;
      if (!cells.length) continue;
      const texts = cells.map((c) => c.text);

      // The footer carries the property address in the item column, so it has
      // to be recognised by the row rather than by its first cell — matched on
      // that alone it reads as one checklist row per page.
      if (texts.some((t) => FOOTER.test(t))) continue;

      if (headerIndex > 0 && index === headerIndex - 1) {
        // The area's title, and the boundary between one area and the next.
        // Rows *above* it on this page still belong to the previous area,
        // whose photographs run on past the page break.
        current = { name: texts.join(' ').trim(), startedOnPage: page.number, items: [], photos: [] };
        areas.push(current);
        continue;
      }
      if (index === headerIndex) continue;

      if (texts.every((t) => TIMESTAMP.test(t))) {
        if (current)
          for (const cell of cells)
            captureTimes.push({
              text: cell.text,
              column: photoColumn(cell.x),
              y: row.y,
              area: current,
            });
        continue;
      }

      if (!current) {
        // The report's own header. Its labels and their values are separate
        // rows in the same columns, so the labels are remembered and read off
        // the row beneath by matching x.
        const found = texts.find((t) => REPORT_DATE.test(t));
        if (found) meta.reportDate = found;
        if (pendingHeaderLabels) {
          for (const { x, key } of pendingHeaderLabels) {
            const value = cells.find((c) => Math.abs(c.x - x) <= 6);
            if (value) meta[key] = value.text;
          }
          pendingHeaderLabels = null;
          continue;
        }
        const labels: Array<{ x: number; key: 'inspector' | 'template' }> = [];
        for (const cell of cells) {
          if (/^Inspector\s*:/.test(cell.text)) labels.push({ x: cell.x, key: 'inspector' });
          if (/^Inspection Template/.test(cell.text)) labels.push({ x: cell.x, key: 'template' });
        }
        if (labels.length) pendingHeaderLabels = labels;
        continue;
      }

      if (texts.some((t) => ['Clean', 'Undamaged', 'Working', 'COMMENTS'].includes(t))) continue;

      const inTable =
        headerIndex !== -1 && index > headerIndex && index <= tableEnds && !looksLikeCaptions(row);
      const hasLabel = cells.some((c) => inBand(c.x, COLUMN.label));

      if (inTable && !hasLabel) {
        const text = cells
          .filter((c) => inBand(c.x, COLUMN.comment))
          .map((c) => c.text)
          .join(' ')
          .trim();
        if (text) wrappedComments.push({ y: row.y, text });
        continue;
      }

      if (inTable && hasLabel) {
        const isClean = gradeAt(row, COLUMN.clean);
        const isUndamaged = gradeAt(row, COLUMN.undamaged);
        const isWorking = gradeAt(row, COLUMN.working);
        const comment = cells.find((c) => inBand(c.x, COLUMN.comment))?.text ?? null;
        const match = matchChecklistLabel(cells[0]!.text);
        const assessed = isClean !== null || isUndamaged !== null || isWorking !== null;

        // A label in the item column matching nothing, with no grade beside
        // it, is not a checklist row — it is a note the inspector typed into
        // the table, such as "SMOKE DETECTOR EXPIRED". Kept for a person to
        // place: dropping it loses a real observation, and importing it as an
        // item invents one nobody approved.
        if (!assessed && match.score < PLAUSIBLE_MATCH) {
          unrecognised.push({ area: current.name, page: page.number, text: cells[0]!.text });
          continue;
        }

        const item: ImportedChecklistItem = {
          sourceLabel: cells[0]!.text,
          matchedLabel: match.label,
          matchScore: match.score,
          isClean,
          isUndamaged,
          isWorking,
          comment,
          assessed,
          page: page.number,
        };
        itemRows.push({ y: row.y, item });
        current.items.push(item);
        continue;
      }

      // Whatever is left below the table names the photographs beside it.
      if (!inTable && cells.every((c) => c.x >= 20 && c.text.length < 60))
        for (const cell of cells)
          captions.push({ text: cell.text, column: photoColumn(cell.x), y: row.y, area: current });
    }

    // A wrapped line belongs to whichever item row it sits closest to, and the
    // lines are rejoined in the order they were drawn — top of the page first,
    // which is descending y. Rejoining in row order would put the second half
    // of the sentence before the first, because the line above the item and
    // the line below it are equally adjacent to it.
    for (const wrapped of wrappedComments) {
      const nearest = [...itemRows].sort(
        (a, b) => Math.abs(a.y - wrapped.y) - Math.abs(b.y - wrapped.y),
      )[0];
      if (!nearest) continue;
      const ownLines = nearest.item.comment ? [{ y: nearest.y, text: nearest.item.comment }] : [];
      const lines = [...ownLines, wrapped].sort((a, b) => b.y - a.y);
      nearest.item.comment = lines
        .map((line) => line.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    // Captions and capture times are drawn as separate rows. Each time is
    // matched to the nearest caption in the same thumbnail column, which keeps
    // the three across the page apart.
    for (const [index, time] of captureTimes.entries()) {
      const nearest = captions
        .filter((caption) => caption.column === time.column && caption.area === time.area)
        .sort((a, b) => Math.abs(a.y - time.y) - Math.abs(b.y - time.y))[0];
      time.area.photos.push({
        caption: nearest?.text ?? null,
        matchedLabel: nearest ? matchChecklistLabel(nearest.text).label : null,
        takenAt: time.text,
        page: page.number,
        index,
      });
    }
  }

  return { ...meta, pages: pages.length, areas, unrecognised };
}

const photoColumn = (x: number) => (x < 200 ? 0 : x < 390 ? 1 : 2);

/** Identifies a file, so the same report cannot be imported twice. */
export const reportFingerprint = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
