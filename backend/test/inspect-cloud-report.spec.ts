import {
  matchChecklistLabel,
  parseReport,
  reportFingerprint,
  type ReportCell,
} from '../src/admin/inspection-import/inspect-cloud-report';
import { extractPhotos } from '../src/admin/inspection-import/inspect-cloud-pdf';

/**
 * Reading an Inspect & Cloud report.
 *
 * Built from the geometry of a real 48-page report rather than from a fixture,
 * so the cases below are the ones that actually went wrong while writing the
 * parser. Every one of them produced valid-looking output when it was broken:
 * grades silently missing, an area silently empty, a caption silently read as
 * a checklist row. None of them would have been caught by "does it parse".
 */

/** Measured column positions. The parser reads bands around these. */
const X = { label: 16, clean: 253, undamaged: 267, working: 281, comment: 293 };
/** Rows are drawn 22 points apart, page top first, y increasing upward. */
const ROW = 22;

const cell = (x: number, y: number, text: string, width = 8): ReportCell => ({
  x,
  y,
  width,
  text,
  rotated: false,
});

/** A page laid out the way the generator lays one out. */
function page(number: number, rows: ReportCell[][], top = 540) {
  const cells = rows.flatMap((row, index) =>
    row.map((entry) => ({ ...entry, y: top - index * ROW })),
  );
  return { number, cells };
}

/** The rotated column legend, which is drawn above the first area's title. */
const legend = (y: number): ReportCell[] => [
  { x: 258, y, width: 20, text: 'Clean', rotated: true },
  { x: 272, y, width: 20, text: 'Undamaged', rotated: true },
  { x: 286, y, width: 20, text: 'Working', rotated: true },
];

const graded = (label: string, grades: string, comment?: string): ReportCell[] => [
  cell(X.label, 0, label, label.length * 6),
  // Drawn as one run, which is how pdf.js hands them over: it merges adjacent
  // text and there is no way to ask it not to.
  cell(X.clean, 0, grades, grades.length * 7),
  ...(comment ? [cell(X.comment, 0, comment, comment.length * 5)] : []),
];

describe('reading an Inspect & Cloud report', () => {
  it('reads each grade into its own column when they are drawn as one run', () => {
    // The failure this prevents is the quiet one: "Y N" arriving as a single
    // item meant one grade was read, the other lost, and the comment beside
    // them swept into the same cell -- 88 items, no findings, nothing that
    // looks broken.
    const report = parseReport([
      page(1, [
        legend(0),
        [cell(12, 0, 'ENTRANCE')],
        [cell(12, 0, 'ROOM/ITEM'), cell(398, 0, 'COMMENTS')],
        graded('DOORS & LOCKS', 'Y Y Y'),
        graded('LIGHTS & POWER POINTS', 'Y Y N', 'Light on wall not coming on'),
      ]),
    ]);

    const [area] = report.areas;
    expect(area?.name).toBe('ENTRANCE');
    expect(area?.items).toHaveLength(2);
    expect(area?.items[0]).toMatchObject({ isClean: true, isUndamaged: true, isWorking: true });
    expect(area?.items[1]).toMatchObject({
      isClean: true,
      isUndamaged: true,
      isWorking: false,
      comment: 'Light on wall not coming on',
    });
  });

  it('records an ungraded row as unassessed rather than failed', () => {
    // A blank row means the inspector did not look. Storing false would turn
    // that into a defect, and a move-out would be compared against damage
    // nobody recorded.
    const report = parseReport([
      page(1, [
        [cell(12, 0, 'ENTRANCE')],
        [cell(12, 0, 'ROOM/ITEM')],
        [cell(X.label, 0, 'WINDOWS & LOCKS', 90)],
        graded('FLOOR/COVERINGS', 'Y Y Y'),
      ]),
    ]);

    expect(report.areas[0]?.items[0]).toMatchObject({
      sourceLabel: 'WINDOWS & LOCKS',
      isClean: null,
      isUndamaged: null,
      isWorking: null,
      assessed: false,
    });
  });

  it('rejoins a comment that wrapped above and below its own row', () => {
    // A long comment is drawn centred against its row, so its lines straddle
    // it. Read in row order the sentence comes out backwards; ending the table
    // at the first line-without-a-label throws the whole area away.
    const report = parseReport([
      page(1, [
        [cell(12, 0, 'BEDROOM 2')],
        [cell(12, 0, 'ROOM/ITEM')],
        [cell(X.comment, 0, 'Entry door not working properly. Handle moves but does not', 200)],
        graded('DOORS & LOCKS', 'Y Y N'),
        [cell(X.comment, 0, 'move the latch connecting to frame', 140)],
        graded('WALLS & CEILINGS', 'Y Y Y'),
      ]),
    ]);

    expect(report.areas[0]?.items).toHaveLength(2);
    expect(report.areas[0]?.items[0]?.comment).toBe(
      'Entry door not working properly. Handle moves but does not move the latch connecting to frame',
    );
  });

  it('does not read the rotated column legend as the name of the first area', () => {
    const report = parseReport([
      page(1, [legend(0), [cell(12, 0, 'ENTRANCE')], [cell(12, 0, 'ROOM/ITEM')], graded('DOORS & LOCKS', 'Y Y Y')]),
    ]);
    expect(report.areas[0]?.name).toBe('ENTRANCE');
  });

  it('ignores the page footer, which carries the address in the item column', () => {
    // The footer sits at x=8, inside the item column. Matched on the first
    // cell alone it reads as one checklist row per page -- 48 of them.
    const report = parseReport([
      page(1, [
        [cell(12, 0, 'ENTRANCE')],
        [cell(12, 0, 'ROOM/ITEM')],
        graded('DOORS & LOCKS', 'Y Y Y'),
        [cell(8, 0, '17307 Nordway dr', 80), cell(510, 0, 'Page 1 of 48', 60)],
      ]),
    ]);
    expect(report.areas[0]?.items).toHaveLength(1);
    expect(report.unrecognised).toHaveLength(0);
  });

  it('keeps a row the inspector typed by hand instead of inventing an item', () => {
    // "SMOKE DETECTOR EXPIRED" is a note, not a template item: no grades and
    // nothing to match. Dropping it loses a real observation; importing it as
    // an item invents one nobody approved.
    const report = parseReport([
      page(1, [
        [cell(12, 0, 'HALLWAY')],
        [cell(12, 0, 'ROOM/ITEM')],
        graded('DOORS & LOCKS', 'Y Y Y'),
        [cell(X.label, 0, 'SMOKE DETECTOR EXPIRED', 130)],
      ]),
    ]);

    expect(report.areas[0]?.items).toHaveLength(1);
    expect(report.unrecognised).toEqual([
      { area: 'HALLWAY', page: 1, text: 'SMOKE DETECTOR EXPIRED' },
    ]);
  });

  it('gives each photograph the item its caption names', () => {
    const report = parseReport([
      page(1, [
        [cell(12, 0, 'ENTRANCE')],
        [cell(12, 0, 'ROOM/ITEM')],
        graded('DOORS & LOCKS', 'Y Y Y'),
        [cell(73, 0, 'DOORS & LOCKS', 70), cell(261, 0, 'WALLS & CEILING', 70)],
        [cell(29, 0, 'Sep 02 2026 01:15:39 PM', 160), cell(217, 0, 'Sep 02 2026 01:16:15 PM', 160)],
      ]),
    ]);

    expect(report.areas[0]?.photos).toEqual([
      expect.objectContaining({ caption: 'DOORS & LOCKS', matchedLabel: 'Doors and locks' }),
      expect.objectContaining({ caption: 'WALLS & CEILING', matchedLabel: 'Walls and ceilings' }),
    ]);
  });

  it('keeps a caption out of the table even when it starts in the item column', () => {
    // Captions are centred under their thumbnail, so a long one begins far
    // enough left to sit in the item column. Read as table it became an extra
    // item carrying the neighbouring caption as its comment.
    const report = parseReport([
      page(1, [
        [cell(12, 0, 'BATHROOM')],
        [cell(12, 0, 'ROOM/ITEM')],
        graded('DOORS & LOCKS', 'Y Y Y'),
        [cell(30, 0, 'BASIN, CABINET VANITY & MIRROR', 150), cell(440, 0, 'TOILET & TOILET ROLL HOLDER', 140)],
        [cell(29, 0, 'Sep 02 2026 01:45:24 PM', 160), cell(406, 0, 'Sep 02 2026 01:45:24 PM', 160)],
      ]),
    ]);

    expect(report.areas[0]?.items).toHaveLength(1);
    expect(report.areas[0]?.photos).toHaveLength(2);
  });

  it('carries photographs of one area across a page where the next one starts', () => {
    // An area's pictures run past the page break, and the next area's title
    // appears above them. Rows before that title still belong to the previous
    // area.
    const report = parseReport([
      page(1, [
        [cell(12, 0, 'ENTRANCE')],
        [cell(12, 0, 'ROOM/ITEM')],
        graded('DOORS & LOCKS', 'Y Y Y'),
      ]),
      page(2, [
        [cell(73, 0, 'DOORS & LOCKS', 70)],
        [cell(29, 0, 'Sep 02 2026 01:15:39 PM', 160)],
        [cell(12, 0, 'LIVING ROOM')],
        [cell(12, 0, 'ROOM/ITEM')],
        graded('WALLS & CEILING', 'Y Y Y'),
      ]),
    ]);

    expect(report.areas.map((area) => area.name)).toEqual(['ENTRANCE', 'LIVING ROOM']);
    expect(report.areas[0]?.photos).toHaveLength(1);
    expect(report.areas[1]?.items).toHaveLength(1);
  });

  it('reads the inspector and template from the header above the first area', () => {
    const report = parseReport([
      page(1, [
        [cell(502, 0, 'SEP-02-2026', 70)],
        [cell(15, 0, 'Inspector :', 50), cell(298, 0, 'Inspection Template:', 90)],
        [cell(15, 0, 'Amy Wilson', 60), cell(298, 0, 'Ingoing Inspection', 90)],
        [cell(12, 0, 'ENTRANCE')],
        [cell(12, 0, 'ROOM/ITEM')],
        graded('DOORS & LOCKS', 'Y Y Y'),
      ]),
    ]);

    expect(report).toMatchObject({
      reportDate: 'SEP-02-2026',
      inspector: 'Amy Wilson',
      template: 'Ingoing Inspection',
    });
  });
});

describe('matching a report label to a template item', () => {
  it('matches through the app’s own keywords, so plurals do not matter', () => {
    // The source is not consistent with itself: one page says "WALLS &
    // CEILING" and another "WALLS & CEILINGS".
    expect(matchChecklistLabel('WALLS & CEILING')).toEqual(
      matchChecklistLabel('WALLS & CEILINGS'),
    );
    expect(matchChecklistLabel('WALLS & CEILING').score).toBe(1);
  });

  it('reports a partial match rather than accepting or discarding it', () => {
    // The source carries a word the template does not. That is a real match,
    // and it is one somebody should confirm.
    const match = matchChecklistLabel('BASIN, CABINET VANITY & MIRROR');
    expect(match.label).toBe('Basin, vanity and mirror');
    expect(match.score).toBeGreaterThan(0.5);
    expect(match.score).toBeLessThan(1);
  });
});

describe('taking the photographs out of the file', () => {
  const jpeg = (width: number, height: number) => {
    const body = Buffer.alloc(24, 0x11);
    body.writeUInt16BE(0xffd8, 0);
    body.writeUInt16BE(0xffc0, 2);
    body.writeUInt16BE(11, 4); // segment length
    body.writeUInt8(8, 6); // precision
    body.writeUInt16BE(height, 7);
    body.writeUInt16BE(width, 9);
    body.writeUInt16BE(0xffd9, 22);
    return body;
  };

  it('finds each JPEG and reads its real size', () => {
    const file = Buffer.concat([
      Buffer.from('%PDF-1.4 padding'),
      jpeg(675, 1200),
      Buffer.from('between streams'),
      jpeg(1200, 675),
    ]);
    expect(extractPhotos(file).map((photo) => `${photo.width}x${photo.height}`)).toEqual([
      '675x1200',
      '1200x675',
    ]);
  });

  it('discards a marker pair that is not really an image', () => {
    // Two bytes alone would match inside any binary data, so a candidate with
    // no readable frame header, or one the size of an icon, is not a photo.
    const file = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0x00, 0xff, 0xd9]), jpeg(16, 16)]);
    expect(extractPhotos(file)).toHaveLength(0);
  });
});

describe('identifying a file', () => {
  it('gives the same report the same fingerprint and a different one another', () => {
    expect(reportFingerprint(Buffer.from('a'))).toBe(reportFingerprint(Buffer.from('a')));
    expect(reportFingerprint(Buffer.from('a'))).not.toBe(reportFingerprint(Buffer.from('b')));
  });
});
