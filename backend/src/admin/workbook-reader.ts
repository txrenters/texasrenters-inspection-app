import { inflateRawSync } from 'node:zlib';

/**
 * Reading an Excel workbook (.xlsx) the office uploads, cell by cell, as the
 * text Excel shows (2026-11-17, PR 4 of Actual vs Budget: the past
 * technicians' logs in "THMP Scheduling Actual Vs Budget 2026.xlsx").
 *
 * An .xlsx is a zip of XML parts. Only the few this needs are read -- the
 * workbook's list of tabs, the shared strings, the number formats and each
 * tab's cells -- with Node's own inflate and no XML library: the parts are
 * machine-written and regular, and nothing here is executed or followed.
 * Everything a hostile file could use to exhaust the server is capped: the
 * file, the number of parts, and what each part may inflate to.
 */

export class WorkbookError extends Error {}

const MAX_ENTRIES = 2000;
/** What one part may inflate to: the largest tab in the office's workbook is 0.6 MB. */
const MAX_PART_BYTES = 40_000_000;
const MAX_TOTAL_BYTES = 150_000_000;
const MAX_ROWS = 20_000;

// ── The zip ─────────────────────────────────────────────────────────────────

interface ZipEntry {
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
}

function zipEntries(file: Buffer): Map<string, ZipEntry> {
  // The end of the central directory: its signature, searched from the end.
  let end = -1;
  for (let at = file.length - 22; at >= Math.max(0, file.length - 65_557); at--) {
    if (file.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new WorkbookError('This is not an Excel workbook (.xlsx).');
  const count = file.readUInt16LE(end + 10);
  if (count > MAX_ENTRIES) throw new WorkbookError('This workbook has more parts than any workbook should.');
  let at = file.readUInt32LE(end + 16);
  const entries = new Map<string, ZipEntry>();
  for (let index = 0; index < count; index++) {
    if (at + 46 > file.length || file.readUInt32LE(at) !== 0x02014b50) throw new WorkbookError('This workbook is damaged.');
    const nameLength = file.readUInt16LE(at + 28);
    const extraLength = file.readUInt16LE(at + 30);
    const commentLength = file.readUInt16LE(at + 32);
    const name = file.toString('utf8', at + 46, at + 46 + nameLength);
    entries.set(name, {
      method: file.readUInt16LE(at + 10),
      compressedSize: file.readUInt32LE(at + 20),
      size: file.readUInt32LE(at + 24),
      offset: file.readUInt32LE(at + 42),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

class Zip {
  private readonly entries: Map<string, ZipEntry>;
  private inflated = 0;

  constructor(private readonly file: Buffer) {
    this.entries = zipEntries(file);
  }

  /** A part as text, or null when the workbook has none of that name. */
  text(name: string): string | null {
    const entry = this.entries.get(name);
    if (!entry) return null;
    const at = entry.offset;
    if (at + 30 > this.file.length || this.file.readUInt32LE(at) !== 0x04034b50) throw new WorkbookError('This workbook is damaged.');
    const start = at + 30 + this.file.readUInt16LE(at + 26) + this.file.readUInt16LE(at + 28);
    const raw = this.file.subarray(start, start + entry.compressedSize);
    let data: Buffer;
    if (entry.method === 0) data = Buffer.from(raw);
    else if (entry.method === 8) {
      try {
        data = inflateRawSync(raw, { maxOutputLength: MAX_PART_BYTES });
      } catch {
        throw new WorkbookError('A part of this workbook is too large or damaged to read.');
      }
    } else throw new WorkbookError('This workbook is packed in a way Excel does not use.');
    this.inflated += data.length;
    if (this.inflated > MAX_TOTAL_BYTES) throw new WorkbookError('This workbook is too large to read.');
    return data.toString('utf8');
  }
}

// ── The XML ─────────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const point = code[1] === 'x' || code[1] === 'X' ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(point) && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
    }
    return ENTITIES[code] ?? whole;
  });

function attributes(tag: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:]+)="([^"]*)"/g)) found[match[1]!] = decode(match[2]!);
  return found;
}

/**
 * Excel's own escape for a character XML cannot hold, "_x000D_" for a carriage
 * return; and a typed line end, kept as one.
 */
const unescapeExcel = (text: string) =>
  text.replace(/_x([0-9A-Fa-f]{4})_/g, (_, code: string) => String.fromCharCode(Number.parseInt(code, 16))).replace(/\r\n?/g, '\n');

/** The text of every <t> in a piece of XML, run together: a rich-text string's runs make one string. */
const texts = (xml: string) =>
  unescapeExcel([...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((match) => decode(match[1]!)).join(''));

// ── Number formats ──────────────────────────────────────────────────────────

const BUILT_IN: Record<number, string> = {
  0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 14: 'm/d/yyyy', 15: 'd-mmm-yy', 16: 'd-mmm',
  17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss', 22: 'm/d/yyyy h:mm', 37: '#,##0;(#,##0)',
  38: '#,##0;[Red](#,##0)', 39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;[Red](#,##0.00)', 41: '_(* #,##0_);_(* \\(#,##0\\);_(* "-"_);_(@_)',
  42: '_("$"* #,##0_);_("$"* \\(#,##0\\);_("$"* "-"_);_(@_)', 43: '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)',
  44: '_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)', 45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mm:ss.0', 49: '@',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const serialDate = (serial: number) => new Date(Date.UTC(1899, 11, 30) + Math.round(serial * 86_400_000));

/** A number as a format shows it, closely enough for a log: dates, times, hours, money, percents. */
export function formatNumber(value: number, code: string): string {
  const sections = code.split(';');
  // What the format says, without its quoted words, escapes, colours and padding.
  const bare = (section: string) => section.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[[^\]]*\]/g, (part) => (/^\[h+\]$/i.test(part) ? part : '')).replace(/[_*]./g, '');
  const first = bare(sections[0] ?? '');
  const lower = first.toLowerCase();
  if (!code || code === 'General' || code === '@') return String(Number(value.toPrecision(12)));
  if (/\[h+\]/.test(lower)) {
    const minutes = Math.round(value * 1440);
    const hm = `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
    return /"h /.test(code) ? hm : `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
  }
  const isDate = /[dy]/.test(lower) || (/m/.test(lower) && !/h/.test(lower) && /[/-]/.test(lower));
  const isTime = /h/.test(lower);
  if (isDate || isTime) {
    const date = serialDate(value);
    const day = date.getUTCDate();
    const month = date.getUTCMonth();
    const year = date.getUTCFullYear();
    const dateText = /mmm/.test(lower)
      ? `${day}-${MONTHS[month]}${/y/.test(lower) ? `-${String(year).slice(2)}` : ''}`
      : `${month + 1}/${day}/${year}`;
    if (!isTime) return dateText;
    const hours = date.getUTCHours();
    const minutes = String(date.getUTCMinutes()).padStart(2, '0');
    const time = /am\/pm/.test(lower) ? `${hours % 12 || 12}:${minutes} ${hours < 12 ? 'AM' : 'PM'}` : `${hours}:${minutes}`;
    return isDate ? `${dateText} ${time}` : time;
  }
  const decimals = (first.split('.')[1] ?? '').replace(/[^0#]/g, '').length;
  if (first.includes('%')) return `${(value * 100).toFixed(decimals)}%`;
  const dollar = /"\$"|\[\$\$|^\$|\$#/.test(sections[0] ?? '');
  if (value === 0 && sections[2] && /"-"/.test(sections[2])) return dollar ? '$ -' : '-';
  const amount = Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: first.includes(','),
  });
  const shown = `${dollar ? '$' : ''}${amount}`;
  if (value >= 0) return shown;
  return sections[1] && /\(/.test(sections[1]) ? `(${shown})` : `-${shown}`;
}

// ── The workbook ────────────────────────────────────────────────────────────

export interface WorkbookSheet {
  name: string;
  hidden: boolean;
  /** Row number -> column letters -> the text Excel shows. */
  rows: Map<number, Map<string, string>>;
}

export function readWorkbook(file: Buffer): WorkbookSheet[] {
  const zip = new Zip(file);
  const workbook = zip.text('xl/workbook.xml');
  if (!workbook) throw new WorkbookError('This is not an Excel workbook (.xlsx).');
  const rels = new Map<string, string>();
  for (const match of (zip.text('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b[^>]*>/g)) {
    const found = attributes(match[0]);
    if (found.Id && found.Target) rels.set(found.Id, found.Target.replace(/^\/?xl\//, '').replace(/^\//, ''));
  }

  const shared = [...(zip.text('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) => texts(match[1]!));
  const styles = zip.text('xl/styles.xml') ?? '';
  const formats = new Map<number, string>();
  for (const match of styles.matchAll(/<numFmt\b[^>]*>/g)) {
    const found = attributes(match[0]);
    formats.set(Number(found.numFmtId), found.formatCode ?? 'General');
  }
  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? '';
  const formatOfStyle = [...cellXfs.matchAll(/<xf\b[^>]*>/g)].map((match) => {
    const id = Number(attributes(match[0]).numFmtId ?? 0);
    return formats.get(id) ?? BUILT_IN[id] ?? 'General';
  });

  const sheets: WorkbookSheet[] = [];
  for (const match of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const found = attributes(match[0]);
    const target = rels.get(found['r:id'] ?? '');
    const xml = target ? zip.text(`xl/${target}`) : null;
    if (!found.name || !xml) continue;
    const rows = new Map<number, Map<string, string>>();
    for (const row of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const number = Number(attributes(row[1]!).r);
      if (!row[2] || !Number.isFinite(number)) continue;
      if (rows.size >= MAX_ROWS) throw new WorkbookError(`The tab "${found.name}" has more rows than this reads.`);
      const cells = new Map<string, string>();
      for (const cell of row[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const at = attributes(cell[1]!);
        const column = /^([A-Z]+)/.exec(at.r ?? '')?.[1];
        const inner = cell[2] ?? '';
        const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        if (!column) continue;
        let text: string;
        if (at.t === 's') text = raw === undefined ? '' : (shared[Number(raw)] ?? '');
        else if (at.t === 'inlineStr') text = texts(inner);
        else if (at.t === 'str' || at.t === 'e') text = raw === undefined ? '' : decode(raw);
        else if (at.t === 'b') text = raw === '1' ? 'TRUE' : raw === undefined ? '' : 'FALSE';
        else if (raw === undefined) text = '';
        else {
          const value = Number(raw);
          text = Number.isFinite(value) ? formatNumber(value, formatOfStyle[Number(at.s ?? 0)] ?? 'General') : decode(raw);
        }
        if (text.trim()) cells.set(column, text);
      }
      if (cells.size) rows.set(number, cells);
    }
    sheets.push({ name: found.name, hidden: found.state === 'hidden' || found.state === 'veryHidden', rows });
  }
  return sheets;
}

// ── A technician's log ──────────────────────────────────────────────────────

const columnNumber = (letters: string) => [...letters].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0);
const columnLetters = (number: number) => {
  let letters = '';
  for (let left = number; left > 0; left = Math.floor((left - 1) / 26)) letters = String.fromCharCode(65 + ((left - 1) % 26)) + letters;
  return letters;
};

/** Past the headings, a figure typed beside the log is kept, up to this many columns in all. */
const MAX_COLUMNS = 30;

/**
 * A tab laid out as a technician's log: its headings -- the row among its first
 * three that names "Address" and "Labor Hours Income" -- and every row under
 * them, as wide as anything typed in them: Omar's tab keeps three figures to
 * the right of its last heading. Null for any other tab.
 */
export function technicianLog(sheet: WorkbookSheet): { headers: string[]; rows: string[][] } | null {
  const headerRow = [...sheet.rows.entries()]
    .filter(([number]) => number <= 3)
    .find(([, cells]) => {
      const words = [...cells.values()].map((text) => text.trim().toLowerCase());
      return words.includes('address') && words.includes('labor hours income');
    });
  if (!headerRow) return null;
  const [headerNumber, headerCells] = headerRow;
  const used = [...sheet.rows.entries()].filter(([number]) => number >= headerNumber).flatMap(([, cells]) => [...cells.keys()].map(columnNumber));
  const width = Math.min(MAX_COLUMNS, Math.max(...used));
  const letters = Array.from({ length: width }, (_, index) => columnLetters(index + 1));
  const rows: string[][] = [];
  for (const [number, cells] of [...sheet.rows.entries()].sort(([left], [right]) => left - right)) {
    if (number <= headerNumber) continue;
    const row = letters.map((letter) => (cells.get(letter) ?? '').trimEnd());
    if (row.some((text) => text.trim())) rows.push(row);
  }
  return { headers: letters.map((letter) => headerCells.get(letter)?.trim() ?? ''), rows };
}
