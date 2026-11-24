import { JobberRecordKind } from '@prisma/client';

import {
  isCutShort,
  MIRROR_KINDS,
  mirrorFilesQuery,
  mirrorKind,
  mirrorOneQuery,
  mirrorPageQuery,
  summarize,
} from '../src/integrations/jobber/jobber-mirror.kinds';

/** What each mirrored kind reads and how a record is found again (2026-11-24). Ids invented. */

describe('the kinds', () => {
  it('reads clients first and every kind once, never invoices', () => {
    expect(MIRROR_KINDS.map((k) => k.kind)).toEqual(['CLIENT', 'PROPERTY', 'JOB', 'VISIT', 'QUOTE', 'REQUEST']);
    expect(MIRROR_KINDS.map((k) => k.connection)).not.toContain('invoices');
  });

  it('asks for a page with first/after, and for changes with the filter the kind supports', () => {
    const jobs = mirrorKind(JobberRecordKind.JOB);
    expect(mirrorPageQuery(jobs, 'walk')).toMatch(/jobs\(first: \$first, after: \$after\s*\)/);
    expect(mirrorPageQuery(jobs, 'changes')).toContain('filter: { updatedAt: { after: $since } }');
    const visits = mirrorKind(JobberRecordKind.VISIT);
    expect(mirrorPageQuery(visits, 'changes')).toContain('filter: { startAt: { after: $from, before: $to } }');
    expect(mirrorPageQuery(visits, 'walk')).toContain('instructions');
  });

  it('carries notes on a page, more of them when a record is read by itself', () => {
    const jobs = mirrorKind(JobberRecordKind.JOB);
    expect(mirrorPageQuery(jobs, 'walk')).toContain('notes(first: 5)');
    expect(mirrorOneQuery(jobs)).toContain('notes(first: 50)');
    expect(mirrorOneQuery(jobs)).toMatch(/job\(id: \$id\)/);
  });

  it('lists attachments with the links the invoice copy already uses', () => {
    const query = mirrorFilesQuery(mirrorKind(JobberRecordKind.JOB));
    expect(query).toContain('noteAttachments(first: 100)');
    expect(query).toContain('downloadUrl');
  });
});

describe('summarize', () => {
  it('finds a job by its number, client, property, start and status', () => {
    const summary = summarize(JobberRecordKind.JOB, {
      id: 'job-1',
      jobNumber: 21127,
      title: 'General Maintenance - WO#44805',
      jobStatus: 'active',
      startAt: '2026-11-24T06:00:00Z',
      createdAt: '2026-11-20T10:00:00Z',
      updatedAt: '2026-11-23T10:00:00Z',
      client: { id: 'client-1', name: '3301 Omega B' },
      property: { id: 'prop-1', address: { street1: '3301 Omega B', street2: null, city: 'Houston', province: 'TX', postalCode: '77022' } },
      noteAttachments: { totalCount: 2 },
    });
    expect(summary).toEqual({
      number: '21127',
      title: 'General Maintenance - WO#44805',
      clientJobberId: 'client-1',
      propertyJobberId: 'prop-1',
      jobJobberId: null,
      address: '3301 Omega B, Houston, TX 77022',
      occursAt: new Date('2026-11-24T06:00:00Z'),
      status: 'active',
      jobberCreatedAt: new Date('2026-11-20T10:00:00Z'),
      jobberUpdatedAt: new Date('2026-11-23T10:00:00Z'),
      fileCount: 2,
    });
  });

  it('files a visit under its job, with no update time', () => {
    const summary = summarize(JobberRecordKind.VISIT, {
      id: 'visit-1',
      title: '3301 Omega B - Zone 1',
      startAt: '2026-11-24T06:00:00Z',
      createdAt: '2026-11-20T10:00:00Z',
      visitStatus: 'UPCOMING',
      job: { id: 'job-1', jobNumber: 21127 },
      client: { id: 'client-1' },
      property: null,
    });
    expect(summary).toMatchObject({ number: '21127', jobJobberId: 'job-1', jobberUpdatedAt: null, address: null, fileCount: 0 });
  });

  it('names a client by name and its billing address, archived or not', () => {
    const summary = summarize(JobberRecordKind.CLIENT, {
      id: 'client-1',
      name: 'Jane Tenant',
      isArchived: true,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-02-01T00:00:00Z',
      billingAddress: { street1: '1 Example Way', city: 'Katy', province: 'TX', postalCode: '77494' },
    });
    expect(summary).toMatchObject({ title: 'Jane Tenant', status: 'archived', address: '1 Example Way, Katy, TX 77494' });
  });

  it('refuses a shape it cannot read rather than guessing', () => {
    expect(() => summarize(JobberRecordKind.JOB, { id: 'job-1', createdAt: 'not a date' })).toThrow(TypeError);
    expect(() => summarize(JobberRecordKind.JOB, { id: 'job-1', title: { not: 'text' } })).toThrow(TypeError);
  });
});

describe('isCutShort', () => {
  it('is true when a nested list holds fewer than Jobber says there are', () => {
    expect(isCutShort({ notes: { totalCount: 6, nodes: [1, 2, 3, 4, 5] } })).toBe(true);
    expect(isCutShort({ notes: { totalCount: 5, nodes: [1, 2, 3, 4, 5] } })).toBe(false);
    // A count asked for on its own is not a list.
    expect(isCutShort({ noteAttachments: { totalCount: 9 } })).toBe(false);
  });
});
