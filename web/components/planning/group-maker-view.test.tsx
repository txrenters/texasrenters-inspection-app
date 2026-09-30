import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ManualState } from './manual-grouping';

import { GroupMakerView } from './group-maker-view';

/**
 * The TBP Property Group maker (2026-09-30): the manual grouping over the
 * database's properties, saved to the server as a template.
 */

const hooks = vi.hoisted(() => ({
  useGroupMakerProperties: vi.fn(),
  useGroupTemplates: vi.fn(),
  useGroupTemplate: vi.fn(),
  useGroupTemplateMutations: vi.fn(),
  useGroupFileOnServer: vi.fn(),
}));
vi.mock('@/lib/planning-queries', () => hooks);
vi.mock('@/lib/auth', () => ({ usePermissions: () => ({ has: () => true }) }));
const url = vi.hoisted(() => ({ state: { template: '' }, set: vi.fn() }));
vi.mock('@/lib/url-state', () => ({ useUrlState: () => [url.state, url.set] }));

/** The map and its panel, reduced to what the maker hands them and hears back. */
vi.mock('@/components/planning/manual-grouping-view', () => ({
  ManualGroupingView: ({
    initial,
    onChange,
    properties,
  }: {
    initial: { state: ManualState };
    onChange: (snapshot: { state: ManualState; minutesPerProperty: number }) => void;
    properties: unknown[];
  }) => (
    <div data-testid="manual-grouping">
      <span>
        {properties.length} properties;{' '}
        {initial.state.groups.map((group) => `${group.name}: ${group.stops.join(',')}`).join(' | ')}
      </span>
      <button
        onClick={() =>
          onChange({
            state: { groups: [{ ...initial.state.groups[0]!, stops: [4, 2, 3] }] },
            minutesPerProperty: 30,
          })
        }
        type="button"
      >
        Add a stop
      </button>
    </div>
  ),
}));

const property = (buildingId: string) => ({
  buildingId,
  address: `${buildingId} Main St`,
  city: 'Houston',
  postalCode: '77009',
  latitude: 29.8,
  longitude: -95.4,
  approximate: false,
  zone: '1',
  hvacPlans: [],
  leases: [],
  units: [],
});

const TEMPLATE = {
  id: '6f0c1d2e-0000-4000-8000-000000000001',
  name: 'Outside in',
  isActive: false,
  minutesPerProperty: 30,
  revision: 4,
  archivedAt: null,
  createdAt: '2026-09-30T12:00:00.000Z',
  updatedAt: '2026-09-30T12:00:00.000Z',
  updatedBy: null,
};

const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
let mutations: Record<string, ReturnType<typeof mutation>>;

function mount({ templates = [{ ...TEMPLATE, groupCount: 1, propertyCount: 2 }] as unknown[] } = {}) {
  hooks.useGroupMakerProperties.mockReturnValue({
    isLoading: false,
    data: { properties: [property('b1'), property('b2'), property('b3')], withoutPosition: 0 },
  });
  hooks.useGroupTemplates.mockReturnValue({ isLoading: false, data: templates });
  hooks.useGroupTemplate.mockReturnValue({
    data: { ...TEMPLATE, groups: [{ position: 1, name: 'North', color: '#e6194b', target: 9, buildingIds: ['b1', 'b2'] }] },
    refetch: vi.fn().mockResolvedValue({}),
  });
  mutations = { create: mutation(), save: mutation(), setActive: mutation(), archive: mutation(), match: mutation() };
  hooks.useGroupTemplateMutations.mockReturnValue(mutations);
  return render(<GroupMakerView />);
}

describe('the Group maker', () => {
  beforeEach(() => {
    url.state = { template: '' };
    url.set.mockReset();
  });

  it('asks for a first template when there is none', () => {
    mount({ templates: [] });

    expect(screen.getByText('No groupings yet')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /New template/ }).length).toBeGreaterThan(0);
  });

  it('opens a template’s groups over every enrolled property', () => {
    mount();

    expect(screen.getByTestId('manual-grouping').textContent).toContain('3 properties; North: 2,3');
    expect((screen.getByRole('textbox', { name: 'Template name' }) as HTMLInputElement).value).toBe('Outside in');
  });

  it('saves nothing until something changes, then saves the buildings in order against the revision it opened', () => {
    mount();
    const save = screen.getByRole('button', { name: /^Save$/ }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Add a stop' }));

    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    expect(mutations.save!.mutate.mock.calls[0][0]).toEqual({
      id: TEMPLATE.id,
      input: {
        name: 'Outside in',
        minutesPerProperty: 30,
        groups: [{ name: 'North', color: '#e6194b', target: 9, buildingIds: ['b3', 'b1', 'b2'] }],
        revision: 4,
      },
    });
  });

  it('counts a rename as a change', () => {
    mount();

    fireEvent.change(screen.getByRole('textbox', { name: 'Template name' }), { target: { value: 'Outside in, Q1' } });

    expect(screen.getByText('Unsaved changes')).toBeTruthy();
  });

  it('makes a template the one new quarters are built from', () => {
    mount();

    fireEvent.click(screen.getByRole('button', { name: /Use for new quarters/ }));

    expect(mutations.setActive!.mutate.mock.calls[0][0]).toEqual({ id: TEMPLATE.id, active: true });
  });
});
