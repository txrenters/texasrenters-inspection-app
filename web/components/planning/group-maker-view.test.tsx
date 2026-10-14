import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ManualState } from './manual-grouping';
import type { ManualLive } from './manual-grouping-view';
import type { TemplateLiveHandlers } from './use-template-live';

import { GroupMakerView } from './group-maker-view';

/**
 * The TBP Property Group maker (2026-09-30), live since 2026-10-01: every
 * change is saved as it is made, and others' changes appear as they are made.
 */

const hooks = vi.hoisted(() => ({
  useGroupMakerProperties: vi.fn(),
  useGroupTemplates: vi.fn(),
  useGroupTemplate: vi.fn(),
  useGroupTemplateChanges: vi.fn(),
  useGroupTemplateMutations: vi.fn(),
  usePlanQuarters: vi.fn(),
  usePlanNotBooked: vi.fn(),
  useGroupFileOnServer: vi.fn(),
  postGroupTemplateOps: vi.fn(),
  readGroupTemplate: vi.fn(),
  readNotBookedGroups: vi.fn(),
  planningKeys: {
    groupTemplates: ['group-templates'],
    groupTemplate: (id: string) => ['group-templates', id],
    groupTemplateChanges: (id: string) => ['group-templates', id, 'changes'],
  },
}));
vi.mock('@/lib/planning-queries', () => hooks);
vi.mock('@/lib/auth', () => ({
  usePermissions: () => ({ has: () => true }),
  useAuth: () => ({ profile: { id: 'me' } }),
}));
const url = vi.hoisted(() => ({ state: { template: '', notBooked: '' }, set: vi.fn() }));
vi.mock('@/lib/url-state', () => ({ useUrlState: () => [url.state, url.set] }));

/** The live channel, reduced to the handlers the maker gives it. */
const channel = vi.hoisted(() => ({ handlers: null as TemplateLiveHandlers | null, focus: vi.fn() }));
vi.mock('@/components/planning/use-template-live', () => ({
  useTemplateLive: (_templateId: string | null, handlers: TemplateLiveHandlers) => {
    channel.handlers = handlers;
    return { connected: true, focus: channel.focus };
  },
}));

/** The map and its panel, reduced to what the maker hands them and hears back. */
vi.mock('@/components/planning/manual-grouping-view', () => ({
  ManualGroupingView: function Stub({
    initial,
    onChange,
    live,
    only,
  }: {
    initial: { state: ManualState; minutesPerProperty: number };
    onChange: (snapshot: { state: ManualState; minutesPerProperty: number }) => void;
    live?: ManualLive;
    only?: ReadonlySet<number> | null;
  }) {
    const [state, setState] = useState(initial.state);
    useEffect(() => {
      if (!live) return;
      live.controls.current = { rebase: (apply) => setState((current) => apply(current)), setMinutes: () => undefined };
    }, [live]);
    useEffect(() => onChange({ state, minutesPerProperty: 30 }), [onChange, state]);
    return (
      <div data-testid="manual-grouping">
        <span data-testid="offered">{only ? [...only].sort().join(',') : 'every property'}</span>
        <span data-testid="groups">{state.groups.map((group) => `${group.name}: ${group.stops.join(',')}`).join(' | ')}</span>
        <span data-testid="editing">
          {[...(live?.editingBy ?? new Map())].map(([groupId, names]) => `${groupId}=${names.join('+')}`).join(' ')}
        </span>
        <button
          onClick={() => setState((current) => ({ groups: [{ ...current.groups[0]!, stops: [...current.groups[0]!.stops, 4] }] }))}
          type="button"
        >
          Add a stop
        </button>
      </div>
    );
  },
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

const TEMPLATE_ID = '6f0c1d2e-0000-4000-8000-000000000001';
const GROUP_ID = '6f0c1d2e-0000-4000-8000-000000000011';
const TEMPLATE = {
  id: TEMPLATE_ID,
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

const NORTH = { id: GROUP_ID, position: 1, name: 'North', color: '#e6194b' };

/** What the server says changed in the package under the open template (2026-10-15). */
const CHANGES = {
  templateId: TEMPLATE_ID,
  revision: 4,
  leavers: [
    {
      buildingId: 'gone',
      address: '9 Gone Ave',
      group: NORTH,
      reasons: [{ code: 'OPTED_OUT', since: '2026-10-14T15:00:00.000Z', by: 'Erika', detail: null }],
    },
  ],
  unplaced: [],
  newcomers: [
    {
      buildingId: 'b3',
      address: 'b3 Main St',
      city: 'Houston',
      zone: '1',
      firstOnReport: '2026-10-12T15:00:00.000Z',
      joinedAt: null,
      suggestions: [
        { group: NORTH, members: 2, target: 9, hasRoom: true, addedMinutes: 4, timing: 'ROAD', nearest: { address: 'b2 Main St', minutes: 3 } },
      ],
    },
  ],
};

function mount({
  templates = [{ ...TEMPLATE, groupCount: 1, propertyCount: 2 }] as unknown[],
  loading = false,
  changes = undefined as unknown,
  notBooked = undefined as unknown,
} = {}) {
  hooks.useGroupTemplateChanges.mockReturnValue({ data: changes });
  hooks.usePlanQuarters.mockReturnValue({
    data: [{ id: 'plan-q4', quarterYear: 2026, quarterNumber: 4, status: 'PUBLISHED' }],
  });
  hooks.usePlanNotBooked.mockReturnValue({ data: notBooked, isError: false });
  hooks.useGroupMakerProperties.mockReturnValue({
    isLoading: false,
    data: { properties: [property('b1'), property('b2'), property('b3')], withoutPosition: 0 },
  });
  hooks.useGroupTemplates.mockReturnValue({ isLoading: loading, data: loading ? undefined : templates });
  hooks.useGroupTemplate.mockReturnValue({
    data: { ...TEMPLATE, groups: [{ id: GROUP_ID, position: 1, name: 'North', color: '#e6194b', target: 9, buildingIds: ['b1', 'b2'] }] },
  });
  hooks.postGroupTemplateOps.mockResolvedValue({ revision: 5 });
  mutations = { create: mutation(), save: mutation(), setActive: mutation(), archive: mutation(), match: mutation() };
  hooks.useGroupTemplateMutations.mockReturnValue(mutations);
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <GroupMakerView />
    </QueryClientProvider>,
  );
}

describe('the Group maker', () => {
  beforeEach(() => {
    url.state = { template: '', notBooked: '' };
    url.set.mockReset();
    hooks.postGroupTemplateOps.mockReset();
    channel.focus.mockReset();
  });

  it('asks for a first template when there is none', () => {
    mount({ templates: [] });

    expect(screen.getByText('No groupings yet')).toBeTruthy();
  });

  it('opens a template’s groups over every enrolled property, with no Save button to forget', () => {
    mount();

    expect(screen.getByTestId('groups').textContent).toBe('North: 2,3');
    expect(screen.queryByRole('button', { name: /^Save$/ })).toBeNull();
    expect(screen.getByText('All changes saved')).toBeTruthy();
    expect(screen.getByText('Live')).toBeTruthy();
  });

  it('sends a change the moment it is made, as what was done', async () => {
    mount();

    fireEvent.click(screen.getByRole('button', { name: 'Add a stop' }));

    await waitFor(() => expect(hooks.postGroupTemplateOps).toHaveBeenCalledTimes(1));
    const [templateId, , ops] = hooks.postGroupTemplateOps.mock.calls[0]!;
    expect(templateId).toBe(TEMPLATE_ID);
    expect(ops).toEqual([{ type: 'stop.add', groupId: GROUP_ID, stop: 'b3' }]);
  });

  it('shows somebody else’s change as it is made, and sends nothing back for it', async () => {
    mount();

    act(() => channel.handlers!.onOps({
      templateId: TEMPLATE_ID,
      revision: 5,
      batchId: 'theirs',
      ops: [{ type: 'stop.add', groupId: GROUP_ID, stop: 'b3' }],
      by: { userId: 'maria', name: 'Maria' },
    }));

    await waitFor(() => expect(screen.getByTestId('groups').textContent).toBe('North: 2,3,4'));
    expect(hooks.postGroupTemplateOps).not.toHaveBeenCalled();
  });

  it('says who else is here, and which group each is building -- never this person', () => {
    mount();

    act(() =>
      channel.handlers!.onPresence([
        { userId: 'me', name: 'Ernie', groupId: GROUP_ID },
        { userId: 'maria', name: 'Maria Santos', groupId: GROUP_ID },
      ]),
    );

    expect(screen.getByText('Also here:')).toBeTruthy();
    expect(screen.getByText('Maria Santos')).toBeTruthy();
    expect(screen.getByTestId('editing').textContent).toBe(`${GROUP_ID}=Maria Santos`);
  });

  it('sends a new name once the typing stops', async () => {
    mount();

    fireEvent.change(screen.getByRole('textbox', { name: 'Template name' }), { target: { value: 'Outside in, Q1' } });

    await waitFor(() => expect(hooks.postGroupTemplateOps).toHaveBeenCalled(), { timeout: 2_000 });
    expect(hooks.postGroupTemplateOps.mock.calls[0]![2]).toEqual([{ type: 'template.update', name: 'Outside in, Q1' }]);
  });

  it('makes a template the one new quarters are built from', () => {
    mount();

    // In More since console-development, with Archive: done once, not a toolbar's worth of buttons.
    fireEvent.pointerDown(screen.getByRole('button', { name: 'More' }), { button: 0, pointerId: 1, pointerType: 'mouse' });
    fireEvent.click(screen.getByRole('menuitem', { name: /Use for new quarters/ }));

    expect(mutations.setActive!.mutate.mock.calls[0][0]).toEqual({ id: TEMPLATE_ID, active: true });
  });

  it('still asks before archiving, from More', () => {
    mount();

    fireEvent.pointerDown(screen.getByRole('button', { name: 'More' }), { button: 0, pointerId: 1, pointerType: 'mouse' });
    fireEvent.click(screen.getByRole('menuitem', { name: /Archive/ }));

    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(mutations.archive!.mutate).not.toHaveBeenCalled();
  });

  describe('benefit package changes (2026-10-15)', () => {
    it('lists who left, with the group each is still in and why, and who is new, with where each would fit', () => {
      mount({ changes: CHANGES });

      expect(screen.getByText(/1 left the package · 1 new, not in a group/)).toBeTruthy();
      expect(screen.getByText('9 Gone Ave')).toBeTruthy();
      expect(screen.getByText(/Opted out of the benefit package on Oct 14, 2026 by Erika/)).toBeTruthy();
      const fit = screen.getByRole('button', { name: 'Add b3 Main St to North' });
      expect(fit.textContent).toContain('+4 min');
      expect(fit.textContent).toContain('2 of 9');
    });

    it('puts a newcomer in the suggested group on the map, and sends it as a click would', async () => {
      mount({ changes: CHANGES });

      fireEvent.click(screen.getByRole('button', { name: 'Add b3 Main St to North' }));

      await waitFor(() => expect(screen.getByTestId('groups').textContent).toBe('North: 2,3,4'));
      await waitFor(() => expect(hooks.postGroupTemplateOps).toHaveBeenCalledTimes(1));
      expect(hooks.postGroupTemplateOps.mock.calls[0]![2]).toEqual([{ type: 'stop.add', groupId: GROUP_ID, stop: 'b3' }]);
    });

    it('takes a leaver out of its group: only the saved template changes, it was never drawn', async () => {
      mount({ changes: CHANGES });

      fireEvent.click(screen.getByRole('button', { name: 'Take 9 Gone Ave out of North' }));

      await waitFor(() => expect(hooks.postGroupTemplateOps).toHaveBeenCalledTimes(1));
      expect(hooks.postGroupTemplateOps.mock.calls[0]![2]).toEqual([{ type: 'stop.remove', stop: 'gone' }]);
      expect(screen.getByTestId('groups').textContent).toBe('North: 2,3');
    });

    it('says so when nothing changed', () => {
      mount({ changes: { ...CHANGES, leavers: [], newcomers: [] } });

      expect(screen.getByText(/every property in it is in a group, and none of the template.s has left/)).toBeTruthy();
    });
  });

  /**
   * The office (2026-10-15): unschedule the rest of Q4 "so we can regroup them
   * using the tbp group maker". Only the properties a Rebuild would lay out are
   * offered; nothing already in a group is taken out of it.
   */
  describe('drawing a template for the rest of a quarter', () => {
    it('offers a quarter’s properties not booked yet', () => {
      mount();

      // Radix opens a select on pointer-down, as it does a menu.
      fireEvent.pointerDown(screen.getByRole('combobox', { name: 'Properties shown' }), {
        button: 0,
        pointerId: 1,
        pointerType: 'mouse',
      });
      fireEvent.click(screen.getByRole('option', { name: /Q4 2026 · unscheduled visits/ }));
      expect(url.set).toHaveBeenCalledWith({ notBooked: 'plan-q4' });
    });

    it('hands the map only those properties, and says how many and why', () => {
      url.state = { template: '', notBooked: 'plan-q4' };
      mount({ notBooked: { planId: 'plan-q4', quarter: 'Q4 2026', visits: 3, buildingIds: ['b2', 'b3', 'b-gone'] } });

      // Rows are numbered from 2, as a file's are: b2 is row 3, b3 row 4.
      expect(screen.getByTestId('offered').textContent).toBe('3,4');
      expect(screen.getByText(/Showing the 2 properties of Q4 2026’s unscheduled/)).toBeTruthy();
      expect(screen.getByText(/1 more have no position, or left the package/)).toBeTruthy();
    });

    /**
     * The office (2026-10-15): "we should have a way on the tbp group maker too
     * to regroup those unscheduled visits for the Q4" -- grouped by the build's
     * own rules, saved as a new template, and opened with only those offered.
     */
    it('makes a template of a quarter’s unscheduled visits in one step, and opens it', async () => {
      mount({ notBooked: { planId: 'plan-q4', quarter: 'Q4 2026', visits: 3, buildingIds: ['b2', 'b3'] } });
      hooks.readNotBookedGroups.mockResolvedValue({
        planId: 'plan-q4',
        quarter: 'Q4 2026',
        visits: 3,
        withoutPosition: 0,
        groups: [{ buildingIds: ['b3', 'b2'], visits: 3 }],
      });
      mutations.create.mutateAsync.mockResolvedValue({ id: 'template-new', name: 'Q4 2026 regroup' });

      fireEvent.click(screen.getByRole('button', { name: 'Regroup unscheduled visits' }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText('3 unscheduled visits in Q4 2026.')).toBeTruthy();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Make the template' }));

      await waitFor(() => expect(url.set).toHaveBeenCalledWith({ template: 'template-new', notBooked: 'plan-q4' }));
      expect(hooks.readNotBookedGroups).toHaveBeenCalledWith('plan-q4');
      expect(mutations.create.mutateAsync.mock.calls[0]![0]).toMatchObject({
        name: 'Q4 2026 regroup',
        groups: [{ name: 'Group 1', target: 2, buildingIds: ['b3', 'b2'] }],
      });
    });

    it('makes nothing for a quarter with no unscheduled visits', async () => {
      mount({ notBooked: { planId: 'plan-q4', quarter: 'Q4 2026', visits: 0, buildingIds: [] } });

      fireEvent.click(screen.getByRole('button', { name: 'Regroup unscheduled visits' }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/has no unscheduled visits/)).toBeTruthy();
      expect((within(dialog).getByRole('button', { name: 'Make the template' }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('offers every property until a quarter is chosen', () => {
      mount();

      expect(screen.getByTestId('offered').textContent).toBe('every property');
    });
  });

  /** Console-development: the page's name stays while its data loads, rather than a blank skeleton. */
  it('keeps the title while the templates load', () => {
    mount({ loading: true });

    expect(screen.getByRole('heading', { name: 'TBP group maker' })).toBeTruthy();
  });
});
