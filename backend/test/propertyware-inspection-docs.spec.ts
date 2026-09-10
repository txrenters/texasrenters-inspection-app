import { InspectionType } from '@prisma/client';

import {
  classifyFileName,
  classifyTemplate,
  dateFromFileName,
  isImportableKind,
  looksLikeInspectionReport,
  worthDownloading,
  type PropertywareDocument,
} from '../src/integrations/propertyware/propertyware.inspection-docs';

/**
 * Telling an inspection report from everything else in a building's documents.
 *
 * Propertyware files every document against the *building* in one list —
 * 12,026 of them across 577 buildings — and nothing says which is an inspection.
 * The REST `/inspections` module is denied to this API client, so a document
 * cannot be joined to the inspection it documents; the filename is all there is
 * before downloading, and some of these are 81 MB.
 *
 * Every filename in this file is real, taken from the live survey.
 */

const document = (overrides: Partial<PropertywareDocument> = {}): PropertywareDocument => ({
  id: 283969026,
  fileName: '7306 Cypress Prairie Dr_Move In Inspection.pdf',
  fileType: 'application/pdf',
  description: '',
  entityType: 'BUILDING',
  entityId: 233900007,
  createdBy: 'msmith',
  createdDateTime: '2024-02-14T19:18:20.000Z',
  lastModifiedDateTime: '2024-02-14T19:18:20.000Z',
  ...overrides,
});

describe('deciding what is worth downloading', () => {
  it('takes a PDF whose name says inspection', () => {
    expect(looksLikeInspectionReport(document())).toBe(true);
  });

  it.each([
    'Texas_Renters.com_PM_renewal_2024.pdf',
    'PMA Renewals 2023.pdf',
    '12419 Iris Hollow Way  Renewal  flood Ins.pdf',
  ])('leaves %s alone', (fileName) => {
    /**
     * The rule is narrow on purpose.
     *
     * A looser one — matching "renewal", or "45 day" — caught these three:
     * property-management agreements and a flood certificate. Each would be a
     * multi-megabyte download and a parse that fails, thousands of times over.
     * A report named without the word "inspection" stays in Propertyware and
     * can still be imported by hand, which is exactly the situation today.
     */
    expect(looksLikeInspectionReport(document({ fileName }))).toBe(false);
  });

  it('ignores a scanned image even when the name fits', () => {
    // The importer takes a PDF. A JPEG named "inspection" is somebody's
    // photograph of a page, and the parser would reject it after paying to
    // fetch it.
    expect(
      looksLikeInspectionReport(
        document({ fileName: 'Move In Inspection.jpg', fileType: 'image/jpg' }),
      ),
    ).toBe(false);
  });
});

describe('guessing the type from the filename', () => {
  it.each([
    ['7306 Cypress Prairie Dr_Move In Inspection.pdf', InspectionType.MOVE_IN],
    ['7306 Cypress Prairie Dr_MI Inspection 07312019.pdf', InspectionType.MOVE_IN],
    ['Move_In_Inspection_7306 Cypress Prairie Dr  (1)_08172020.pdf', InspectionType.MOVE_IN],
    ['7306 Cypress Prairie Dr MO Inspection.pdf', InspectionType.MOVE_OUT],
    ['Move out_Inspection_7306 Cypress Prairie Dr_08052020.pdf', InspectionType.MOVE_OUT],
    ['7306 Cypress Prairie Dr_Occupied Inspection .pdf', InspectionType.OCCUPIED],
    ['Occupied_Inspection_12419 Iris hollow way.pdf', InspectionType.OCCUPIED],
    ['12419 Iris Hollow Way_Safety Inspection_052419.pdf', InspectionType.OCCUPIED],
    ['7306 Cypress Prairie Dr_HVAC Inspection.pdf', InspectionType.HVAC],
  ])('reads %s as %s', (fileName, expected) => {
    expect(classifyFileName(fileName)).toBe(expected);
  });

  it('does not read a comparison as either inspection it names', () => {
    /**
     * `7306 Cypress Prairie Dr MOVE IN VS MOVE OUT.pdf` contains both "move
     * in" and "move out", so whichever is tested first wins — and both answers
     * are wrong. It is a summary written for an owner, not a walkthrough, and
     * importing it as a move-in would attach one inspection's evidence to the
     * other's record. There were 51 of these in the survey.
     */
    expect(classifyFileName('7306 Cypress Prairie Dr MOVE IN VS MOVE OUT.pdf')).toBe('COMPARISON');
    expect(isImportableKind(classifyFileName('MI vs MO 1234 Somewhere.pdf'))).toBe(false);
  });

  it.each([
    ['4742 Tain Dr_EXIT inspection 03082017.pdf', InspectionType.MOVE_OUT],
    ['1506 Spencer Glen Ln_occupiedinspection .pdf', InspectionType.OCCUPIED],
    ['19615 Kingston Green Ln_OccupiedInspection .pdf', InspectionType.OCCUPIED],
    ['479 Folk Crest Ln_Saftey Inspection_07012020.pdf', InspectionType.OCCUPIED],
  ])('reads %s, which the first run could not', (fileName, expected) => {
    /**
     * Every one of these sat unclassified after the first real discovery run.
     *
     * `occupiedinspection` is the interesting one: written with no separator at
     * all, so `\boccupied\b` had no word boundary to match and four occupied
     * inspections went unrecognised. `EXIT` is the office's other word for a
     * move-out, on thirteen files, and `Saftey` is their typo, not ours to
     * correct in their filenames.
     */
    expect(classifyFileName(fileName)).toBe(expected);
  });

  it('leaves a turnover unclassified rather than guessing', () => {
    // 39 files say "Turnover" or "TO Inspection", and that is genuinely
    // ambiguous between a move-out and a back-to-market. Guessing either from
    // the name would invent a fact the PDF already states, so these are
    // downloaded and read instead.
    expect(classifyFileName('13722 Lynnwood Ln_Turnover Inspection.pdf')).toBe('UNKNOWN');
    expect(worthDownloading(classifyFileName('10542 Paula Bluff Ln TO Inspection.pdf'))).toBe(true);
  });

  it('never fetches an inspection that is somebody else’s', () => {
    // An HOA walk and a municipal compliance visit concern the property but are
    // not walkthroughs of the tenancy, and no template inside them would be
    // recognised. Skipped without paying for the download.
    const hoa = classifyFileName('10339_solitude_acct#229042_HOA_INSPECTION_02052021.pdf');
    const city = classifyFileName('2926 Riata Ln_City Of Houston_Inspection_Pending Items.pdf');
    expect(hoa).toBe('NOT_AN_INSPECTION');
    expect(city).toBe('NOT_AN_INSPECTION');
    expect(worthDownloading(hoa)).toBe(false);
    expect(worthDownloading(city)).toBe(false);
  });

  it('does not find a type inside an ordinary word', () => {
    // "mo" and "mi" are the office's abbreviations and are matched as whole
    // words for this reason: a report about mildew or moisture is not a
    // move-in, and there is no undoing that once the evidence is written.
    expect(classifyFileName('Moisture Inspection 12 Somewhere.pdf')).toBe('UNKNOWN');
    expect(classifyFileName('Mildew Inspection.pdf')).toBe('UNKNOWN');
  });
});

describe('reading the type the report states about itself', () => {
  it('sees through the spaces the PDF text layer inserts', () => {
    /**
     * The trap this function exists for.
     *
     * The template line arrives from the PDF's text layer with **spaces inside
     * words** — these are the real strings, copied from parsed reports:
     * "Ingo ing Inspect io n", "Ro ut ine Inspect io n", "Occupied Inspect io n".
     * They are glyph positions rather than characters; the extractor starts a
     * new run wherever the renderer moved the pen, and this report's font does
     * that mid-word. Matching the raw string finds nothing at all, so every
     * space is stripped before comparison rather than collapsed to one.
     */
    expect(classifyTemplate('Ingo ing Inspect io n')).toBe(InspectionType.MOVE_IN);
    expect(classifyTemplate('Occupied Inspect io n')).toBe(InspectionType.OCCUPIED);
    expect(classifyTemplate('Ro ut ine Inspect io n')).toBe(InspectionType.OCCUPIED);
  });

  it('treats Routine and Occupied as one thing', () => {
    // The office renamed the template; reports under both names are still in
    // Propertyware, and they are the same visit.
    expect(classifyTemplate('Routine Inspection')).toBe(classifyTemplate('Occupied Inspection'));
  });

  it('says nothing rather than guessing when there is no template', () => {
    // An unrecognised template is a document that gets catalogued and left
    // alone. Falling back to the filename here would defeat the point of
    // reading the report: the filename is what we are checking.
    expect(classifyTemplate(null)).toBe('UNKNOWN');
    expect(classifyTemplate('   ')).toBe('UNKNOWN');
    expect(classifyTemplate('Annual Fire Safety Certificate')).toBe('UNKNOWN');
  });
});

describe('the date in a filename', () => {
  it('reads the office format', () => {
    expect(dateFromFileName('7306 Cypress Prairie_Safety Inspection_031819.pdf')).toBeNull();
    expect(dateFromFileName('Move out_Inspection_7306 Cypress Prairie_08052020.pdf')).toBe(
      '2020-08-05',
    );
  });

  it('refuses a house number that looks like a date', () => {
    // `1123 Runneburg Rd` is an address. Read as a date it is the year 1123,
    // and an inspection dated then sorts before everything and matches nothing.
    expect(dateFromFileName('1123 Runneburg Rd_Safety Inspection.pdf')).toBeNull();
  });
});
