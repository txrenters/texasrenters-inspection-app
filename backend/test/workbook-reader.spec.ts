import { deflateRawSync } from 'node:zlib';

import { UserRole } from '@prisma/client';

import { ActualVsBudgetService } from '../src/admin/actual-vs-budget.service';
import { WorkbookError, formatNumber, readWorkbook, technicianLog } from '../src/admin/workbook-reader';
import type { AuthenticatedUser } from '../src/common/auth';

/**
 * Reading the office's workbook for Actual vs Budget's past technicians' logs
 * (2026-11-17, PR 4). The workbook here is built in the test, as Excel lays
 * one out, with invented rows; the real one never enters the repository.
 */

/** A zip, as an .xlsx is one: each part deflated, or stored as it is. */
function zip(parts: Record<string, string>, stored = false): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(parts)) {
    const data = Buffer.from(text, 'utf8');
    const packed = stored ? data : deflateRawSync(data);
    const nameBytes = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(parts).length, 8);
  end.writeUInt16LE(Object.keys(parts).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const HEADERS = ['Date', 'Address', 'WO#', 'Job#', 'Drive Time', 'Time Budgeted', 'Labor Revenue Budget', 'Arrival Time', 'Time Leaving', 'Actual Time', 'Is the Work Complete?', 'Re-Schedule Required?', 'Date For Re-schedule', 'Labor Hours Income', 'Trip Charge', 'Materials', 'Invoice #', 'Date Posted in PW', 'Issues/Notes'];
const letters = 'ABCDEFGHIJKLMNOPQRS'.split('');
// Shared strings: the headings, then the row's words. One rich-text string, and one with Excel's escaped return.
const strings = [...HEADERS, '100 Example Way - Zone 2 - Occupied', 'yes', 'no', '6980/INV-1570_x000D_', 'Total', 'Tenant &amp; dog home'];
const at = (text: string) => strings.indexOf(text);
const sharedStrings = `<?xml version="1.0"?><sst>${strings
  .map((text, index) => (index === at('yes') ? '<si><r><t>y</t></r><r><t>es</t></r><rPh><t>X</t></rPh></si>' : `<si><t>${text}</t></si>`))
  .join('')}</sst>`;
const styles = `<?xml version="1.0"?><styleSheet>
  <numFmts count="3"><numFmt numFmtId="164" formatCode="_(* #,##0.00_);_(* \\(#,##0.00\\);_(* &quot;-&quot;??_);_(@_)"/><numFmt numFmtId="165" formatCode="[$-409]h:mm\\ AM/PM;@"/><numFmt numFmtId="166" formatCode="[h]&quot;h &quot;mm&quot;m&quot;"/></numFmts>
  <cellXfs count="5"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="166"/></cellXfs>
</styleSheet>`;
const s = (column: string, row: number, text: string) => `<c r="${column}${row}" t="s"><v>${at(text)}</v></c>`;
const n = (column: string, row: number, value: number, style: number) => `<c r="${column}${row}" s="${style}"><v>${value}</v></c>`;
const log = `<?xml version="1.0"?><worksheet><sheetData>
  <row r="1">${HEADERS.map((header, index) => s(letters[index]!, 1, header)).join('')}</row>
  <row r="2">${n('A', 2, 46337, 1)}${s('B', 2, '100 Example Way - Zone 2 - Occupied')}${n('D', 2, 20988, 0)}${n('H', 2, 0.7333333333, 3)}${n('I', 2, 0.7444444444, 3)}${n('J', 2, 0.0111111111, 4)}${s('K', 2, 'yes')}${s('L', 2, 'no')}${n('N', 2, 103.5, 2)}${n('O', 2, 0, 2)}${s('Q', 2, '6980/INV-1570_x000D_')}${s('S', 2, 'Tenant &amp; dog home')}<c r="U2"><v>125</v></c></row>
  <row r="3"></row>
  <row r="4">${s('A', 4, 'Total')}<c r="N4" s="2"><f>SUM(N2:N3)</f><v>-12.5</v></c><c r="P4" t="e"><f>Nathan!#REF!</f><v>#REF!</v></c></row>
</sheetData></worksheet>`;
const other = `<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Summary</t></is></c></row></sheetData></worksheet>`;
const parts = {
  '[Content_Types].xml': '<Types/>',
  'xl/workbook.xml': `<?xml version="1.0"?><workbook xmlns:r="r"><sheets>
    <sheet name="Nathan" sheetId="4" state="hidden" r:id="rId1"/><sheet name="Summary-May" sheetId="12" state="hidden" r:id="rId2"/><sheet name="Amy" sheetId="24" r:id="rId3"/>
  </sheets></workbook>`,
  'xl/_rels/workbook.xml.rels': `<?xml version="1.0"?><Relationships>
    <Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Target="/xl/worksheets/sheet3.xml"/>
  </Relationships>`,
  'xl/sharedStrings.xml': sharedStrings,
  'xl/styles.xml': styles,
  'xl/worksheets/sheet1.xml': log,
  'xl/worksheets/sheet2.xml': other,
  'xl/worksheets/sheet3.xml': log,
};

describe('reading a workbook', () => {
  it('reads every tab, deflated or stored, with whether it is hidden', () => {
    for (const stored of [false, true]) {
      const sheets = readWorkbook(zip(parts, stored));
      expect(sheets.map((sheet) => [sheet.name, sheet.hidden])).toEqual([['Nathan', true], ['Summary-May', true], ['Amy', false]]);
    }
  });

  it("shows each cell as Excel shows it, in the cell's own format", () => {
    const [nathan] = readWorkbook(zip(parts));
    const page = technicianLog(nathan!)!;
    expect(page.headers.slice(0, 19)).toEqual(HEADERS);
    expect(page.rows[0]!.slice(0, 19)).toEqual([
      '11/11/2026', '100 Example Way - Zone 2 - Occupied', '', '20988', '', '', '', '5:36 PM', '5:52 PM', '0h 16m', 'yes', 'no', '', '103.50', '-', '', '6980/INV-1570', '', 'Tenant & dog home',
    ]);
    // A figure typed beside the log, past its last heading, is kept.
    expect(page.headers).toHaveLength(21);
    expect(page.rows[0]![20]).toBe('125');
  });

  it('keeps Total rows, negative sums and broken formulas as the workbook showed them, and skips empty rows', () => {
    const page = technicianLog(readWorkbook(zip(parts))[0]!)!;
    expect(page.rows).toHaveLength(2);
    expect(page.rows[1]![0]).toBe('Total');
    expect(page.rows[1]![13]).toBe('(12.50)');
    expect(page.rows[1]![15]).toBe('#REF!');
  });

  it('is not a technician log unless its headings say so', () => {
    expect(technicianLog(readWorkbook(zip(parts))[1]!)).toBeNull();
  });

  it('refuses a file that is not a workbook, and a part that inflates too far', () => {
    expect(() => readWorkbook(Buffer.from('not a zip at all'))).toThrow(WorkbookError);
    const bomb = zip({ ...parts, 'xl/worksheets/sheet1.xml': `<worksheet>${' '.repeat(45_000_000)}</worksheet>` });
    expect(() => readWorkbook(bomb)).toThrow(WorkbookError);
  });
});

describe('number formats', () => {
  it('cover the formats the workbook uses', () => {
    expect(formatNumber(46337, 'm/d/yyyy')).toBe('11/11/2026');
    expect(formatNumber(46024, 'd-mmm-yy')).toBe('2-Jan-26');
    expect(formatNumber(0.5625, 'h:mm AM/PM')).toBe('1:30 PM');
    expect(formatNumber(0.35069444, '[h]"h "mm"m"')).toBe('8h 25m');
    expect(formatNumber(0.8220, '0.00%')).toBe('82.20%');
    expect(formatNumber(1078.99, '"$"#,##0.00_);[Red]\\("$"#,##0.00\\)')).toBe('$1,078.99');
    expect(formatNumber(-75.353, '_([$$-409]* #,##0.00_);_([$$-409]* \\(#,##0.00\\);_([$$-409]* "-"??_);_(@_)')).toBe('($75.35)');
    expect(formatNumber(0, '_([$$-409]* #,##0.00_);_([$$-409]* \\(#,##0.00\\);_([$$-409]* "-"??_);_(@_)')).toBe('$ -');
    expect(formatNumber(18796, 'General')).toBe('18796');
    expect(formatNumber(0.1 + 0.2, 'General')).toBe('0.3');
  });
});

describe('importing the past logs', () => {
  const office = {
    id: '60000000-0000-4000-8000-000000000009',
    organizationId: '60000000-0000-4000-8000-000000000001',
    roles: [UserRole.INSPECTION_SUPERVISOR],
    permissions: ['invoices:read', 'invoices:manage'],
    principalType: 'USER',
  } as AuthenticatedUser;

  function database() {
    const saved: Record<string, unknown>[] = [];
    const audits: Record<string, unknown>[] = [];
    const db: Record<string, unknown> = {
      revenueHistorySheet: { upsert: jest.fn(async ({ create }: { create: Record<string, unknown> }) => saved.push(create)) },
      auditLog: { create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => audits.push(data)) },
      $transaction: jest.fn(async (work: (tx: unknown) => unknown): Promise<unknown> => work(db)),
    };
    return { db, saved, audits };
  }

  it("keeps the hidden technician tabs only -- the tabs in use are the console's own now", async () => {
    const { db, saved, audits } = database();
    const result = await new ActualVsBudgetService(db as never).importHistory(office, { originalname: 'Actual Vs Budget.xlsx', size: 1000, buffer: zip(parts) });
    expect(result).toEqual({ imported: [{ name: 'Nathan', rowCount: 2 }] });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ name: 'Nathan', rowCount: 2, fileName: 'Actual Vs Budget.xlsx', importedById: office.id });
    expect(audits[0]).toMatchObject({ action: 'REVENUE_HISTORY_IMPORTED', metadata: { tabs: [{ name: 'Nathan', rows: 2 }] } });
  });

  it('says so when the file is not a workbook, or has no past logs', async () => {
    const service = new ActualVsBudgetService(database().db as never);
    await expect(service.importHistory(office, { originalname: 'x.pdf', size: 10, buffer: Buffer.from('%PDF-1.7') })).rejects.toMatchObject({ code: 'NOT_A_WORKBOOK' });
    const visibleOnly = zip({ ...parts, 'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="Amy" sheetId="24" r:id="rId3"/></sheets></workbook>' });
    await expect(service.importHistory(office, { originalname: 'x.xlsx', size: 10, buffer: visibleOnly })).rejects.toMatchObject({ code: 'NO_PAST_LOGS' });
    await expect(service.importHistory(office, undefined)).rejects.toMatchObject({ code: 'NO_WORKBOOK' });
  });
});
