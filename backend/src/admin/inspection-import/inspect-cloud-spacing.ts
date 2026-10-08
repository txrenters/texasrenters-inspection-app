/**
 * Putting back the word breaks an Inspect & Cloud report actually drew.
 *
 * pdf.js decides where spaces go from the holes between glyphs: one wider
 * than about a tenth of the font size (its `TRACKING_SPACE_FACTOR`, 0.102)
 * reads as a word break, and there is no option to turn that off. The report's
 * generator, Qt 5.5.1, places every glyph with its own `Td` move rounded to a
 * whole point. In the 10pt comment font the "s" is 4.96pt wide and advanced 6,
 * a hole of 0.104em, just over the line. So every "s" not already followed by a
 * space came out with one after it: "s hower runs non s top", "cons tantly",
 * "cracks .". Other letters at other sizes do the same ("Ingo ing Inspect io n"
 * in the header), and the result printed on the comparison owners and tenants
 * read.
 *
 * The file is unambiguous about where its words break, because Qt draws a real
 * space glyph between every pair of words. So the spaces kept are the ones the
 * file drew, plus any hole wide enough to be a word break nobody drew; a space
 * pdf.js inferred from a narrower hole is removed. Nothing is decided from the
 * letters themselves: "it s" and "is a" have a drawn space between them and
 * keep it, whatever they spell.
 *
 * Pure, so it is tested against operator lists shaped like the ones pdf.js
 * returns for a real report, without loading pdf.js under jest.
 */

/**
 * Below this, in ems, a hole is two letters of one word.
 *
 * Measured over 25 real reports, 255,916 pairs of letters with no space drawn
 * between them: Qt's rounding leaves at most 0.148em, and pdf.js calls a space
 * from 0.102em. Not one hole of 0.2em or more went undrawn. A proportional
 * font's word space is about a quarter of an em, so a hole below this is never
 * a word break some other generator left for the reader to infer.
 */
const SAME_WORD = 0.2;

/** One character the page drew, in the order it drew them. */
export interface DrawnChar {
  char: string;
  /** Drawn as a space glyph: a word break the file put there itself. */
  space: boolean;
  /**
   * The hole between this glyph and the end of the one before it, in ems.
   * Null when it cannot be measured: the first glyph of a text object, the
   * first after a new line, or after anything else that moves text by more
   * than a plain offset along the line.
   */
  gap: number | null;
}

/** The part of pdf.js's `PDFOperatorList` this reads. */
export interface OperatorList {
  fnArray: ArrayLike<number>;
  argsArray: ArrayLike<unknown>;
}

/** A glyph as pdf.js hands it over in `showText`, or a TJ offset. */
type ShownGlyph =
  | number
  | null
  | { unicode?: string; width?: number; isSpace?: boolean; vmetric?: unknown };

/**
 * Every character a page draws, with the hole before it.
 *
 * Positions are tracked in text space along the current line: `pen` is how far
 * the text has advanced from the line's start, and `lastEnd` is where the
 * previous glyph finished, in the same frame. A `Td` starts a new line offset
 * from the old one, which is how Qt places each glyph, so the previous glyph's
 * end is carried across it. Anything that moves text some other way (a new
 * text matrix, a line feed, a change of transform) makes the next hole
 * unmeasurable, and an unmeasured hole always keeps its space.
 *
 * pdf.js has already turned TJ, `'` and `"` into `showText` by the time the
 * operator list is built, with TJ's offsets left in the glyph array as numbers.
 */
export function drawnText(operators: OperatorList, OPS: Readonly<Record<string, number>>): DrawnChar[] {
  const drawn: DrawnChar[] = [];
  let state = { fontSize: 0, charSpacing: 0, wordSpacing: 0, hScale: 1 };
  const saved: Array<typeof state> = [];
  let pen = 0;
  let lastEnd: number | null = null;

  for (let index = 0; index < operators.fnArray.length; index += 1) {
    const fn = operators.fnArray[index];
    const args = (operators.argsArray[index] ?? []) as unknown[];
    switch (fn) {
      case OPS.setFont:
        state = { ...state, fontSize: Math.abs(Number(args[1]) || 0) };
        break;
      case OPS.setCharSpacing:
        state = { ...state, charSpacing: Number(args[0]) || 0 };
        break;
      case OPS.setWordSpacing:
        state = { ...state, wordSpacing: Number(args[0]) || 0 };
        break;
      case OPS.setHScale:
        state = { ...state, hScale: (Number(args[0]) || 100) / 100 };
        break;
      case OPS.save:
        saved.push(state);
        break;
      case OPS.restore:
        state = saved.pop() ?? state;
        lastEnd = null;
        break;
      case OPS.moveText:
      case OPS.setLeadingMoveText: {
        const [tx, ty] = args.map(Number);
        lastEnd = lastEnd !== null && ty === 0 && Number.isFinite(tx) ? lastEnd - tx! : null;
        pen = 0;
        break;
      }
      case OPS.beginText:
      case OPS.endText:
      case OPS.setTextMatrix:
      case OPS.nextLine:
        pen = 0;
        lastEnd = null;
        break;
      case OPS.transform:
      case OPS.setTextRise:
      case OPS.paintFormXObjectBegin:
      case OPS.paintFormXObjectEnd:
        lastEnd = null;
        break;
      case OPS.showText:
        for (const glyph of (args[0] ?? []) as ShownGlyph[]) {
          if (typeof glyph === 'number') {
            pen -= (glyph / 1000) * state.fontSize * state.hScale;
            continue;
          }
          if (!glyph) continue;
          const measurable =
            lastEnd !== null && state.fontSize > 0 && state.hScale === 1 && !glyph.vmetric;
          const gap = measurable ? (pen - lastEnd!) / state.fontSize : null;
          const text = (glyph.unicode ?? '').normalize('NFKC');
          if (glyph.isSpace || (text && !text.trim())) drawn.push({ char: ' ', space: true, gap });
          else
            [...text].forEach((char, position) =>
              drawn.push({ char, space: false, gap: position === 0 ? gap : 0 }),
            );
          const width = ((glyph.width ?? 0) / 1000) * state.fontSize;
          pen += (width + state.charSpacing + (glyph.isSpace ? state.wordSpacing : 0)) * state.hScale;
          lastEnd = pen;
        }
        break;
      default:
        break;
    }
  }
  return drawn;
}

/**
 * pdf.js's text for each item on a page, keeping only the spaces the page drew.
 *
 * Items arrive in the order the content stream drew them, so each is matched
 * against the drawn characters from where the previous one ended. An item that
 * cannot be matched letter for letter is returned exactly as pdf.js gave it:
 * the worst this can do is nothing. It never adds a space pdf.js left out.
 */
export function respace(items: readonly string[], drawn: readonly DrawnChar[]): string[] {
  let cursor = 0;
  return items.map((item) => {
    const chars = [...item];
    const letters = chars.flatMap((char, index) => (char.trim() ? [index] : []));
    if (!letters.length) return item;
    const at = locate(letters.map((index) => chars[index]!), drawn, cursor);
    if (!at) return item;
    cursor = at[at.length - 1]! + 1;

    let text = chars.slice(0, letters[0]! + 1).join('');
    for (let k = 1; k < letters.length; k += 1) {
      const between = chars.slice(letters[k - 1]! + 1, letters[k]).join('');
      if (between && isWordBreak(drawn, at[k - 1]!, at[k]!)) text += between;
      text += chars[letters[k]!];
    }
    return text + chars.slice(letters[letters.length - 1]! + 1).join('');
  });
}

/** Where a run of letters was drawn, ignoring drawn spaces, from `from` on. */
function locate(letters: string[], drawn: readonly DrawnChar[], from: number): number[] | null {
  for (let start = from; start < drawn.length; start += 1) {
    if (drawn[start]!.space || drawn[start]!.char !== letters[0]) continue;
    const at = [start];
    for (let next = start + 1; at.length < letters.length && next < drawn.length; next += 1) {
      if (drawn[next]!.space) continue;
      if (drawn[next]!.char !== letters[at.length]) break;
      at.push(next);
    }
    if (at.length === letters.length) return at;
  }
  return null;
}

/** Whether the page drew a word break between two of its characters. */
function isWordBreak(drawn: readonly DrawnChar[], before: number, after: number) {
  for (let index = before + 1; index < after; index += 1) if (drawn[index]!.space) return true;
  const { gap } = drawn[after]!;
  return gap === null || gap >= SAME_WORD;
}

/** How the importer joins two report rows' comments that land on one item. */
const JOINED = ' — ';

/**
 * Comments stored before this fix, put right from the same report read again.
 *
 * What told a real space from an invented one was the page's geometry, and
 * that was never stored. So a stored comment is matched against the report's
 * comments as the importer reads them now: one whose letters are exactly one
 * comment's, and which differs from it only by spaces the new reading does not
 * have, becomes that reading. Anything else, a comment somebody edited since
 * included, comes back exactly as it was stored. Two rows' comments joined on
 * one item are put right part by part.
 */
export function storedCommentRespacer(readings: Iterable<string>) {
  const byLetters = new Map<string, Set<string>>();
  for (const reading of readings) {
    const key = reading.replace(/\s+/g, '');
    byLetters.set(key, (byLetters.get(key) ?? new Set()).add(reading));
  }
  const respaced = (stored: string) => {
    const found = byLetters.get(stored.replace(/\s+/g, ''));
    if (found?.size !== 1) return null;
    const [reading] = found;
    return reading !== stored && onlyLosesSpaces(stored, reading!) ? reading! : null;
  };
  return (stored: string) =>
    respaced(stored) ??
    stored
      .split(JOINED)
      .map((part) => respaced(part) ?? part)
      .join(JOINED);
}

/** Whether `after` is `before` with some of its spaces taken out, and nothing else. */
function onlyLosesSpaces(before: string, after: string) {
  const from = [...before];
  let index = 0;
  for (const char of after) {
    while (from[index] === ' ' && char !== ' ') index += 1;
    if (from[index] !== char) return false;
    index += 1;
  }
  return from.slice(index).every((char) => char === ' ');
}
