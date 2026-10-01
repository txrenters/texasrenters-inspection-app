import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { PlanBuildChoice } from './plan-build-dialog';

/**
 * Building a quarter from the office's group template (2026-10-01): "it still
 * asks us how many visits a day even though I selected my TBP group template".
 * A template sets each day, so the dialog stops asking -- and the grouping is
 * chosen before the rest, because it decides what the rest is.
 */

const TEMPLATE = {
  id: '6f0c1d2e-0000-4000-8000-000000000001',
  name: 'Optimized Drive time',
  isActive: true,
  groupCount: 45,
  propertyCount: 393,
  revision: 692,
  updatedAt: '2026-10-01T12:00:00.000Z',
  archivedAt: null,
};

vi.mock('@/lib/planning-queries', () => ({
  usePlanTechnicians: () => ({
    isLoading: false,
    data: [{ id: 'tech-moses', displayName: 'Moses Rodriguez', crewOrder: 1, hasHome: true }],
  }),
  useGroupTemplates: () => ({ isLoading: false, data: [TEMPLATE] }),
}));

const { PlanBuildDialog } = await import('./plan-build-dialog');

const Q1 = { year: 2027, quarter: 1 as const };

function open(props: Partial<Parameters<typeof PlanBuildDialog>[0]> = {}) {
  const onBuild = vi.fn<(choice: PlanBuildChoice) => void>();
  render(
    <PlanBuildDialog label="Q1 2027" onBuild={onBuild} onOpenChange={() => {}} open quarter={Q1} rebuild={false} {...props} />,
  );
  const build = () => fireEvent.click(screen.getByRole('button', { name: /^(Build|Rebuild) / }));
  return { onBuild, build };
}

const legends = () => screen.getAllByRole('group').map((group) => group.querySelector('legend')?.textContent);

describe('building from a group template', () => {
  it('does not ask how many visits a day', () => {
    open({ groupTemplate: { id: TEMPLATE.id, name: TEMPLATE.name, revision: 692, archivedAt: null } });

    expect(legends()).not.toContain('Visits a day');
  });

  it('sends no day size, so the template sets each day', () => {
    const { onBuild, build } = open();
    fireEvent.click(screen.getByRole('radio', { name: /Optimized Drive time/ }));
    build();

    expect(onBuild.mock.calls[0]![0]).toMatchObject({ groupTemplateId: TEMPLATE.id, stopsPerDay: null });
  });

  it('says the days are the template’s groups', () => {
    open({ groupTemplate: { id: TEMPLATE.id, name: TEMPLATE.name, revision: 692, archivedAt: null } });

    expect(screen.getByText(/Each day is one of the groups of “Optimized Drive time”/)).toBeTruthy();
  });

  /**
   * The office (2026-10-02): "we don't need this zone selector if we use the
   * template cause we already removed zone 5". A template's groups already say
   * which properties a quarter has, so none is left out of it.
   */
  it('does not ask which zones, and leaves none out', () => {
    const { onBuild, build } = open();
    expect(legends()).toContain('Zones');

    fireEvent.click(screen.getByRole('radio', { name: /Optimized Drive time/ }));
    expect(legends()).not.toContain('Zones');
    build();

    expect(onBuild.mock.calls[0]![0]).toMatchObject({ groupTemplateId: TEMPLATE.id, excludedZones: [] });
  });

  it('asks for the grouping right after who gets the visits, before the crew and the dates', () => {
    open();

    expect(legends().slice(0, 4)).toEqual(['Who gets the visits', 'Grouping', 'Technicians', 'Start']);
  });
});

describe('building with the planner’s own grouping', () => {
  it('still asks how many visits a day, and sends the answer', () => {
    const { onBuild, build } = open();
    const sizes = screen.getAllByRole('group').find((group) => group.querySelector('legend')?.textContent === 'Visits a day')!;
    fireEvent.click(within(sizes).getByRole('radio', { name: /10 a day/ }));
    build();

    expect(onBuild.mock.calls[0]![0]).toMatchObject({ groupTemplateId: null, stopsPerDay: 10 });
  });

  it('reopens a rebuild on the quarter’s own day size rather than on nine', () => {
    const { onBuild, build } = open({ rebuild: true, stopsPerDay: 10 });
    build();

    expect(onBuild.mock.calls[0]![0].stopsPerDay).toBe(10);
  });

  it('opens on nine for a size it does not offer', () => {
    const { onBuild, build } = open({ rebuild: true, stopsPerDay: 7 });
    build();

    expect(onBuild.mock.calls[0]![0].stopsPerDay).toBe(9);
  });
});
