import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { ApplicationError } from '../src/common/errors';
import { TechnicianCompleteInspectionDto } from '../src/technician/technician.dto';
import { TechnicianService } from '../src/technician/technician.service';

/**
 * The services report a technician sends when submitting a benefit-package
 * visit: each booked service done or not, why not, and whether to book it again.
 */

const DETAILS = 'Filter Change: 20x25x1; 12x12x1 + Pest Control + Occupied Inspection (Basic Plan)';

type ReportFor = (
  inspection: { jobberVisitDetails: string | null },
  report: TechnicianCompleteInspectionDto['servicesReport'],
) => unknown;
// Uses nothing from the instance, so it is exercised without building one.
const servicesReportFor = (TechnicianService.prototype as unknown as { servicesReportFor: ReportFor }).servicesReportFor;

const complete = {
  services: {
    filterChange: { done: true },
    pestControl: { done: false, reason: '  Tenant asked not to spray today.  ', reschedule: true },
  },
  filtersInstalled: ['20 X 25 x 1', '20x25x1', '12x12x1'],
  notes: ' Hallway register was blocked. ',
};

describe('what a submission may carry', () => {
  const errorsFor = async (body: unknown) =>
    validate(plainToInstance(TechnicianCompleteInspectionDto, body), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

  it('accepts no body at all, which is what every older app sends', async () => {
    expect(await errorsFor({})).toEqual([]);
  });

  it('accepts a full report', async () => {
    expect(await errorsFor({ servicesReport: complete })).toEqual([]);
  });

  it('refuses a filter size that is not one, and a service it does not know', async () => {
    expect(await errorsFor({ servicesReport: { ...complete, filtersInstalled: ['the big one'] } })).not.toEqual([]);
    expect(
      await errorsFor({ servicesReport: { ...complete, services: { ...complete.services, gutters: { done: true } } } }),
    ).not.toEqual([]);
  });
});

describe('the report stored with a submission', () => {
  it('keeps each booked service, trims the reason, and reads each filter size one way', () => {
    expect(servicesReportFor({ jobberVisitDetails: DETAILS }, complete)).toEqual({
      services: {
        filterChange: { done: true, reason: null, reschedule: false },
        pestControl: { done: false, reason: 'Tenant asked not to spray today.', reschedule: true },
      },
      // One entry per filter installed, a size as often as it went in: the
      // count is what is invoiced.
      filtersInstalled: ['20x25x1', '20x25x1', '12x12x1'],
      notes: 'Hallway register was blocked.',
    });
  });

  it('refuses a report that leaves a booked service unanswered, or not done without a reason', () => {
    const attempt = (services: Record<string, unknown>) => () =>
      servicesReportFor({ jobberVisitDetails: DETAILS }, { ...complete, services } as never);

    expect(attempt({ filterChange: { done: true } })).toThrow(ApplicationError);
    expect(attempt({ filterChange: { done: true } })).toThrow('Mark pest control done or not done.');
    expect(attempt({ filterChange: { done: true }, pestControl: { done: false, reason: ' ' } })).toThrow(
      'Say why pest control was not done.',
    );
  });

  it('is nothing from an app that sent no report, so an un-updated phone can still submit', () => {
    expect(servicesReportFor({ jobberVisitDetails: DETAILS }, undefined)).toBeNull();
  });

  it('drops a service the visit never booked, and filters when none were changed', () => {
    const stored = servicesReportFor(
      { jobberVisitDetails: 'Filter Change: 20x25x1 + Pest Control' },
      {
        services: {
          filterChange: { done: false, reason: 'Wrong size in the van.', reschedule: true },
          pestControl: { done: true },
          fleaTreatment: { done: true },
        },
        filtersInstalled: ['20x25x1'],
      },
    ) as { services: Record<string, unknown>; filtersInstalled: string[] };
    expect(Object.keys(stored.services)).toEqual(['filterChange', 'pestControl']);
    expect(stored.filtersInstalled).toEqual([]);
  });

  /**
   * `servicesReportProblems` reads a *missing* `filters` as an older phone, one
   * that answers the filter change as a single service, and returns without
   * checking a register. Dropping the key for an empty array told it exactly
   * that about a current phone -- so a job where not one register had been
   * answered went through with the filter change ticked done, and the office
   * got "Filter Change: done" over two filters nobody had touched.
   *
   * The distinction is presence, not length: said nothing, or said there are
   * none.
   */
  it('refuses a submission that answers no register, where an empty list used to pass', () => {
    expect(() =>
      servicesReportFor({ jobberVisitDetails: DETAILS }, {
        services: { filterChange: { done: true }, pestControl: { done: true } },
        filters: [],
        filtersInstalled: [],
      } as never),
    ).toThrow(/Answer for the/);
  });

  it('still asks nothing of a phone that never spoke of registers', () => {
    const stored = servicesReportFor({ jobberVisitDetails: DETAILS }, {
      services: { filterChange: { done: true }, pestControl: { done: true } },
      filtersInstalled: ['20x25x1'],
    } as never) as { filters?: unknown[] };

    expect(stored.filters).toBeUndefined();
  });

  /**
   * A register the visit never listed is the technician correcting the office's
   * record. It is kept -- and `booked` is decided here from the Details, never
   * taken from the phone, so a client cannot dress a listed register up as one
   * found on site.
   */
  it('keeps a register found on site, and the handset key its photograph has', () => {
    const stored = servicesReportFor({ jobberVisitDetails: DETAILS }, {
      services: { filterChange: { done: true }, pestControl: { done: true } },
      filters: [
        { size: '20x25x1', location: null, slot: 1, changed: true, photoKey: 'snapshot-1' },
        { size: '12x12x1', location: null, slot: 1, changed: true, photoKey: 'snapshot-2' },
        { size: '16x20x1', location: 'attic', slot: 1, changed: true, photoKey: 'snapshot-3', booked: true },
      ],
      filtersInstalled: [],
    } as never) as { filters: { size: string; booked: boolean; photoKey: string | null }[] };

    expect(stored.filters.map((filter) => [filter.size, filter.booked])).toEqual([
      ['20x25x1', true],
      ['12x12x1', true],
      ['16x20x1', false],
    ]);
    // All a photograph has until it uploads, and the field that was being lost.
    expect(stored.filters.map((filter) => filter.photoKey)).toEqual([
      'snapshot-1',
      'snapshot-2',
      'snapshot-3',
    ]);
  });
});
