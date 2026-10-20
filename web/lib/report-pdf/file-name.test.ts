/**
 * @vitest-environment node
 *
 * Node, because the disposition is checked against the Headers class the route
 * handler builds its response with.
 */
import { describe, expect, it } from 'vitest';

import { InspectionType } from '@texasrenters/shared';

import {
  attachmentDisposition,
  inspectionFileLabel,
  propertyFileStem,
  reportPdfFileName,
} from './file-name';

const property = (addressLine1: string, unitName: string | null = null) => ({
  name: 'Sample',
  addressLine1,
  unitName,
});

describe('report file names', () => {
  it('names every inspection type in the words Propertyware files it under', () => {
    expect(Object.values(InspectionType).map(inspectionFileLabel)).toEqual([
      'Move In Inspection',
      'Occupied Inspection',
      'Back to Market Inspection',
      'Move Out Inspection',
      'HVAC Inspection',
      'Roof Inspection',
      'Supra Lockbox Placement',
      'Supra Lockbox Removal',
      'AC Filter Delivery',
    ]);
  });

  it('spells a type it does not know from the enum', () => {
    expect(inspectionFileLabel('POOL_CHECK')).toBe('Pool Check Inspection');
  });

  it('joins the address and the inspection with an underscore', () => {
    expect(reportPdfFileName(property('7 Example Oak Ct'), 'Occupied Inspection')).toBe(
      '7 Example Oak Ct_Occupied Inspection.pdf',
    );
  });

  it('keeps the capitals the address was stored with and raises an all-lowercase word', () => {
    expect(propertyFileStem(property('101 FM 9999 McSample rd'))).toBe('101 FM 9999 McSample Rd');
    expect(propertyFileStem(property('22 fictional 3rd st'))).toBe('22 Fictional 3rd St');
    expect(propertyFileStem(property('9 Ñandú sample St'))).toBe('9 Ñandú Sample St');
    expect(propertyFileStem(property('9 ñandú Sample St'))).toBe('9 Ñandú Sample St');
  });

  it('names the unit, so the two halves of a duplex do not share a name', () => {
    expect(propertyFileStem(property('40 Madeup Ave', 'B'))).toBe('40 Madeup Ave Unit B');
  });

  it('drops characters Windows refuses in a file name', () => {
    expect(propertyFileStem(property('5 Sample "Rd": 1/2 <A>|*?'))).toBe('5 Sample Rd 1 2 A');
  });

  it('falls back to the property name, then to the label alone', () => {
    expect(reportPdfFileName({ name: 'Sample House', addressLine1: '' }, 'Roof Inspection')).toBe(
      'Sample House_Roof Inspection.pdf',
    );
    expect(reportPdfFileName({ name: '', addressLine1: '' }, 'Roof Inspection')).toBe(
      'Roof Inspection.pdf',
    );
  });
});

describe('attachmentDisposition', () => {
  it('quotes the name, spaces and all', () => {
    expect(attachmentDisposition('7 Example Oak Ct_Occupied Inspection.pdf')).toBe(
      `attachment; filename="7 Example Oak Ct_Occupied Inspection.pdf"; ` +
        `filename*=UTF-8''7%20Example%20Oak%20Ct_Occupied%20Inspection.pdf`,
    );
  });

  it('gives an accented name in full to filename* and as ASCII to filename', () => {
    const disposition = attachmentDisposition('9 Ñandú Sample St_Roof Inspection.pdf');

    expect(disposition).toContain('filename="9 Nandu Sample St_Roof Inspection.pdf"');
    expect(disposition).toContain(`filename*=UTF-8''9%20%C3%91and%C3%BA%20Sample`);
    // A raw non-ASCII header value throws here, which would fail the download.
    expect(() => new Headers({ 'content-disposition': disposition })).not.toThrow();
  });
});
