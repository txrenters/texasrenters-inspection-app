import {
  drawnText,
  respace,
  storedCommentRespacer,
  type OperatorList,
} from '../src/admin/inspection-import/inspect-cloud-spacing';

/**
 * Word breaks in an Inspect & Cloud report.
 *
 * Built from the geometry of real reports. Qt places every glyph with its own
 * `Td`, so a line is fully described by each glyph's width and how far Qt moved
 * on after drawing it. pdf.js cannot be loaded under jest, so what it reads
 * from that geometry is modelled from its own rule (`readByPdfjs` below), and
 * every case first checks that the model produces the broken text the office
 * actually saw. A fixture that stopped reproducing the fault would otherwise
 * keep passing while testing nothing.
 */

/** pdf.js's own operator codes (`pdfjs.OPS`), copied because jest cannot load it. */
const OPS = {
  save: 10,
  restore: 11,
  transform: 12,
  beginText: 31,
  endText: 32,
  setCharSpacing: 33,
  setWordSpacing: 34,
  setHScale: 35,
  setFont: 37,
  setTextRise: 39,
  moveText: 40,
  setLeadingMoveText: 41,
  setTextMatrix: 42,
  nextLine: 43,
  showText: 44,
  paintFormXObjectBegin: 74,
  paintFormXObjectEnd: 75,
};

/** pdf.js reads a hole of this many ems between two glyphs as a space. */
const PDFJS_SPACE = 0.102;

interface Font {
  name: string;
  size: number;
  /** Width in thousandths of an em, and Qt's move after it in points. */
  metrics: Record<string, [width: number, advance: number]>;
}

/**
 * The 10pt comment font. Measured from a real report wherever its glyphs
 * appeared; the rest are the same face's widths with Qt's move rounded to the
 * nearest point.
 *
 * The "s" is the line that matters: 4.96pt wide, moved 6. That leaves a hole
 * of 0.104em, over pdf.js's 0.102.
 */
const COMMENT: Font = {
  name: 'g_d0_f2',
  size: 10,
  metrics: {
    ' ': [276, 3], // measured; Qt's space glyph reads back as a tab
    P: [662, 7], // measured
    a: [552, 6], // measured
    c: [496, 5], // measured
    e: [552, 6], // measured
    g: [552, 6], // measured
    h: [552, 6], // measured
    i: [220, 3], // measured
    l: [220, 3], // measured
    n: [552, 6], // measured
    o: [552, 5], // measured
    p: [552, 6], // measured
    r: [330, 4], // measured
    s: [496, 6], // measured
    t: [276, 3], // measured
    '.': [276, 3], // measured
    B: [662, 7],
    D: [718, 7],
    F: [606, 6],
    N: [718, 7],
    Y: [662, 7],
    b: [552, 6],
    d: [552, 6],
    f: [276, 3],
    k: [496, 5],
    m: [830, 8],
    u: [552, 6],
    v: [496, 5],
    w: [718, 7],
    y: [496, 5],
    ',': [276, 3],
    '/': [276, 3],
  },
};

/** The 11pt header font, measured from the "Ingoing Inspection" title. */
const HEADER: Font = {
  name: 'g_d0_f3',
  size: 11,
  metrics: {
    ' ': [276, 3],
    I: [276, 3],
    c: [552, 7],
    e: [552, 7],
    g: [606, 7],
    i: [276, 3],
    n: [606, 7],
    o: [606, 8],
    p: [606, 7],
    s: [552, 7],
    t: [330, 5],
  },
};

const glyph = (char: string, width: number) => ({
  unicode: char === ' ' ? '\t' : char,
  width,
  isSpace: false,
});

/**
 * One run of text drawn the way Qt draws it, and what pdf.js reads from it.
 *
 * Every glyph has its own `Td` and `Tj`, and the run is its own text object.
 */
function drawnLine(text: string, font: Font = COMMENT) {
  const fnArray: number[] = [OPS.beginText, OPS.setFont, OPS.setTextMatrix, OPS.moveText];
  const argsArray: unknown[] = [null, [font.name, font.size], [[1, 0, 0, -1, 0, 0]], [293, -452]];
  [...text].forEach((char, index) => {
    const metric = font.metrics[char];
    if (!metric) throw new Error(`no metrics for ${JSON.stringify(char)} in ${font.name}`);
    if (index > 0) {
      fnArray.push(OPS.moveText);
      argsArray.push([font.metrics[text[index - 1]!]![1], 0]);
    }
    fnArray.push(OPS.showText);
    argsArray.push([[glyph(char, metric[0])]]);
  });
  fnArray.push(OPS.endText);
  argsArray.push(null);
  return { fnArray, argsArray, reading: readByPdfjs(text, font) };
}

/**
 * pdf.js's reading of a Qt line: a space wherever one was drawn, and also
 * wherever the hole after a letter is over a tenth of an em.
 */
function readByPdfjs(text: string, font: Font) {
  let reading = '';
  let spaceDrawn = false;
  [...text].forEach((char, index) => {
    if (char === ' ') {
      spaceDrawn = true;
      return;
    }
    const before = text[index - 1];
    if (before !== undefined && before !== ' ') {
      const [width, advance] = font.metrics[before]!;
      if ((advance - (width * font.size) / 1000) / font.size >= PDFJS_SPACE) spaceDrawn = true;
    }
    if (spaceDrawn && reading) reading += ' ';
    spaceDrawn = false;
    reading += char;
  });
  return reading;
}

/** Several operator lists drawn one after another on a single page. */
function page(...parts: OperatorList[]): OperatorList {
  return {
    fnArray: parts.flatMap((part) => [...Array.from(part.fnArray)]),
    argsArray: parts.flatMap((part) => [...Array.from(part.argsArray)]),
  };
}

const repaired = (items: string[], operators: OperatorList) =>
  respace(items, drawnText(operators, OPS));

describe('putting back the word breaks an Inspect & Cloud report drew', () => {
  it.each([
    [
      'shower runs non stop even when in the off position',
      's hower runs non s top even when in the off pos ition',
    ],
    [
      'toilet constantly filling, makes screeching noise heard throughout home',
      'toilet cons tantly filling, makes s creeching nois e heard throughout home',
    ],
    ['shower / bath does not run', 's hower / bath does not run'],
  ])('reads "%s" as it was typed, not as pdf.js split it', (typed, splitByPdfjs) => {
    const line = drawnLine(typed);
    // The fixture reproduces what printed on the comparison report.
    expect(line.reading).toBe(splitByPdfjs);
    expect(repaired([line.reading], line)).toEqual([typed]);
  });

  it('joins any letter split the same way, not only an "s"', () => {
    // A rule about a lone "s" would leave the header broken, and could never
    // tell "weathers tripping" from two words.
    const header = drawnLine('Ingoing Inspection', HEADER);
    expect(header.reading).toBe('Ingo ing Inspect io n');
    expect(repaired([header.reading], header)).toEqual(['Ingoing Inspection']);

    const comment = drawnLine('Back door weatherstripping needs to be secured');
    expect(comment.reading).toBe('Back door weathers tripping needs to be s ecured');
    expect(repaired([comment.reading], comment)).toEqual([
      'Back door weatherstripping needs to be secured',
    ]);
  });

  it('keeps every space the inspector typed, whatever the words spell', () => {
    // "it s" and "is a" look exactly like the split, and a rule written about
    // the letters would join them. The file drew a space there; it stays.
    const line = drawnLine('it s a fact, this is a fault');
    expect(line.reading).toBe('it s a fact, this is a fault');
    expect(repaired([line.reading], line)).toEqual(['it s a fact, this is a fault']);

    // A space typed before a comma is kept; one pdf.js put before a full stop
    // after an "s" is not.
    const punctuated = drawnLine('Foundation cracks. Paint trim , door');
    expect(punctuated.reading).toBe('Foundation cracks . Paint trim , door');
    expect(repaired([punctuated.reading], punctuated)).toEqual([
      'Foundation cracks. Paint trim , door',
    ]);
  });

  it('keeps the space between runs drawn as separate text', () => {
    // The undamaged and working grades are drawn separately and pdf.js merges
    // them into one item. Losing that space would lose a grade.
    const operators = page(drawnLine('Y'), drawnLine('N'));
    expect(repaired(['Y N'], operators)).toEqual(['Y N']);
  });

  it('keeps a word break nobody drew when the hole is as wide as a space', () => {
    // Other generators space words by moving the pen instead of drawing a
    // space glyph. That hole is a word break even though nothing marks it.
    const word = (text: string) => [...text].map((char) => glyph(char, 500));
    const tj: OperatorList = {
      fnArray: [OPS.beginText, OPS.setFont, OPS.showText, OPS.endText],
      argsArray: [null, ['F1', 10], [[...word('Leaking'), -280, ...word('pipe')]], null],
    };
    expect(repaired(['Leaking pipe'], tj)).toEqual(['Leaking pipe']);

    // The same pen move made with `Td`.
    const td: OperatorList = {
      fnArray: [OPS.beginText, OPS.setFont, OPS.showText, OPS.moveText, OPS.showText, OPS.endText],
      argsArray: [null, ['F1', 10], [[glyph('a', 500)]], [8, 0], [[glyph('b', 500)]], null],
    };
    expect(repaired(['a b'], td)).toEqual(['a b']);
  });

  it('never measures across a new line or a new transform', () => {
    // Positions in different frames cannot be compared, so the space stays.
    for (const move of [
      { fn: OPS.moveText, args: [5, -12] },
      { fn: OPS.setTextMatrix, args: [[1, 0, 0, 1, 0, 0]] },
      { fn: OPS.nextLine, args: null },
      { fn: OPS.transform, args: [1, 0, 0, 1, 0, 0] },
      { fn: OPS.restore, args: null },
    ]) {
      const operators: OperatorList = {
        fnArray: [OPS.beginText, OPS.setFont, OPS.showText, move.fn, OPS.showText, OPS.endText],
        argsArray: [null, ['F1', 10], [[glyph('a', 500)]], move.args, [[glyph('b', 500)]], null],
      };
      expect(repaired(['a b'], operators)).toEqual(['a b']);
    }
  });

  it('repairs each item at its own place on the page', () => {
    const first = drawnLine('shower leaks');
    const second = drawnLine('Paint closet');
    const third = drawnLine('shower leaks');
    expect(
      repaired(
        [first.reading, second.reading, third.reading],
        page(first, second, third),
      ),
    ).toEqual(['shower leaks', 'Paint closet', 'shower leaks']);
  });

  it('leaves text it cannot find on the page exactly as pdf.js gave it', () => {
    // An item the drawn glyphs do not spell is not guessed at, and does not
    // throw the items after it out of step.
    const line = drawnLine('Paint closet');
    expect(repaired(['Not on this page', line.reading], line)).toEqual([
      'Not on this page',
      'Paint closet',
    ]);
  });

  it('leaves blank items and single letters alone', () => {
    const line = drawnLine('s');
    expect(repaired(['', '   ', 's'], line)).toEqual(['', '   ', 's']);
  });
});

describe('putting right a comment stored before the fix', () => {
  const readings = [
    'shower runs non stop even when in the off position',
    'Missing 2 blind panels',
    'it s a fault',
    'Miss a handle',
    'Missa handle',
  ];
  const respaceStored = storedCommentRespacer(readings);

  it('becomes the comment the importer reads today', () => {
    expect(respaceStored('s hower runs non s top even when in the off pos ition')).toBe(
      'shower runs non stop even when in the off position',
    );
  });

  it('puts right each of two rows joined on one item', () => {
    expect(respaceStored('Mis s ing 2 blind panels — s hower runs non s top even when in the off pos ition')).toBe(
      'Missing 2 blind panels — shower runs non stop even when in the off position',
    );
  });

  it('leaves a comment somebody has edited since exactly as it is', () => {
    expect(respaceStored('s hower runs non s top, tenant told')).toBe('s hower runs non s top, tenant told');
    expect(respaceStored('S hower runs non s top even when in the off pos ition')).toBe(
      'S hower runs non s top even when in the off pos ition',
    );
  });

  it('only ever takes spaces out', () => {
    // The reading keeps a space the stored text lacks: that is not this fault.
    expect(respaceStored('its a fault')).toBe('its a fault');
    expect(respaceStored('it s a fault')).toBe('it s a fault');
  });

  it('leaves a comment two readings could both be', () => {
    expect(respaceStored('Mis s a handle')).toBe('Mis s a handle');
  });

  it('leaves comments that are not in the report alone', () => {
    expect(respaceStored('Blinds need replacing')).toBe('Blinds need replacing');
  });
});

describe('readPages', () => {
  const content = [
    { str: 's hower runs non s top', transform: [10, 0, 0, 10, 293, 451.6], width: 101.5 },
    { str: '   ', transform: [10, 0, 0, 10, 395, 451.6], width: 3 },
    { str: 'Y N', transform: [11, 0, 0, 11, 267, 446], width: 21.3 },
  ];
  const getDocument = jest.fn();

  beforeAll(() => {
    jest.resetModules();
    jest.doMock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
      OPS,
      VerbosityLevel: { ERRORS: 0, WARNINGS: 1, INFOS: 5 },
      getDocument,
    }));
  });

  it('reads text with the spaces the page drew, at the positions pdf.js gave', async () => {
    const operators = page(drawnLine('shower runs non stop'), drawnLine('Y'), drawnLine('N'));
    getDocument.mockReturnValue({
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({
          getTextContent: async () => ({ items: content }),
          getOperatorList: async () => operators,
          cleanup: () => undefined,
        }),
        cleanup: async () => undefined,
      }),
    });
    const { readPages } = await import('../src/admin/inspection-import/inspect-cloud-pdf');

    const pages = await readPages(Buffer.from('%PDF-1.4'));

    expect(pages).toEqual([
      {
        number: 1,
        cells: [
          { x: 293, y: 452, width: 101.5, text: 'shower runs non stop', rotated: false },
          { x: 267, y: 446, width: 21.3, text: 'Y N', rotated: false },
        ],
      },
    ]);
    // Photographs are dropped before they are decoded, and quietly: the
    // operator list is only wanted for its glyphs.
    expect(getDocument).toHaveBeenCalledWith(
      expect.objectContaining({ maxImageSize: 1, verbosity: 0 }),
    );
  });
});
