/**
 * Getting text and photographs out of an Inspect & Cloud PDF.
 *
 * Split from the parser so the structural rules can be tested against
 * synthesised cells without a real file, and so the one part that depends on
 * pdf.js is small enough to read in a sitting.
 */
import type { ReportCell } from './inspect-cloud-report';

/** Anything smaller is a rule or an icon, not a photograph from the walk. */
const SMALLEST_PHOTO = 32;

export interface ExtractedPhoto {
  /** The original JPEG, byte for byte. */
  bytes: Buffer;
  width: number;
  height: number;
}

/**
 * Text runs with their positions, one entry per page.
 *
 * The legacy build is the one that runs under Node without a DOM. Fonts are
 * never fetched: the report's own metrics are all the parser reads.
 */
export async function readPages(bytes: Buffer): Promise<Array<{ number: number; cells: ReportCell[] }>> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const document = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: true,
  }).promise;

  try {
    const pages: Array<{ number: number; cells: ReportCell[] }> = [];
    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      const cells = content.items.flatMap((item) => {
        if (!('str' in item) || !item.str.trim()) return [];
        const transform = item.transform as number[];
        return [
          {
            x: transform[4]!,
            y: Math.round(transform[5]!),
            width: item.width ?? 0,
            text: item.str.replace(/\s+/g, ' ').trim(),
            // The three column headers are drawn on a slant; every value in
            // the table is upright.
            rotated: Math.abs(transform[1]!) > 0.01 || Math.abs(transform[2]!) > 0.01,
          },
        ];
      });
      pages.push({ number, cells });
      page.cleanup();
    }
    return pages;
  } finally {
    await document.cleanup();
  }
}

/** How many images each page draws, in the order it draws them. */
export async function countPhotosPerPage(bytes: Buffer): Promise<number[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const document = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: true,
  }).promise;
  try {
    const counts: number[] = [];
    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number);
      const operators = await page.getOperatorList();
      let drawn = 0;
      for (const operator of operators.fnArray)
        if (operator === pdfjs.OPS.paintImageXObject) drawn += 1;
      counts.push(drawn);
      page.cleanup();
    }
    return counts;
  } finally {
    await document.cleanup();
  }
}

/**
 * The report's photographs, as the JPEGs the file already contains.
 *
 * Taken from the raw streams rather than through pdf.js, which decodes to
 * RGB — 2.4 MB a frame for a 675x1200 photo, and re-encoding it would cost
 * both quality and a new image dependency to store a picture the file was
 * already carrying losslessly.
 *
 * A DCTDecode stream *is* a JPEG file, so each one is found by its start and
 * end markers. Those two bytes alone would also match inside other binary
 * data, so every candidate has its frame header read: anything without a
 * readable size, or smaller than a thumbnail, is discarded.
 */
export function extractPhotos(bytes: Buffer): ExtractedPhoto[] {
  const photos: ExtractedPhoto[] = [];
  for (let start = 0; start < bytes.length - 3; start += 1) {
    if (bytes[start] !== 0xff || bytes[start + 1] !== 0xd8 || bytes[start + 2] !== 0xff) continue;
    for (let end = start + 2; end < bytes.length - 1; end += 1) {
      if (bytes[end] !== 0xff || bytes[end + 1] !== 0xd9) continue;
      const candidate = bytes.subarray(start, end + 2);
      const size = frameSize(candidate);
      if (size && size.width >= SMALLEST_PHOTO && size.height >= SMALLEST_PHOTO)
        photos.push({ bytes: candidate, ...size });
      start = end + 1;
      break;
    }
  }
  return photos;
}

/** Width and height from a JPEG's start-of-frame marker, or null if malformed. */
function frameSize(jpeg: Buffer): { width: number; height: number } | null {
  let cursor = 2;
  while (cursor < jpeg.length - 9) {
    if (jpeg[cursor] !== 0xff) {
      cursor += 1;
      continue;
    }
    const marker = jpeg[cursor + 1]!;
    // Any start-of-frame carries the size. C4, C8 and CC are tables and
    // extensions that happen to sit in the same range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
      return { height: jpeg.readUInt16BE(cursor + 5), width: jpeg.readUInt16BE(cursor + 7) };
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      cursor += 2;
      continue;
    }
    cursor += 2 + jpeg.readUInt16BE(cursor + 2);
  }
  return null;
}
