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
      filtersInstalled: ['20x25x1', '12x12x1'],
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
});
