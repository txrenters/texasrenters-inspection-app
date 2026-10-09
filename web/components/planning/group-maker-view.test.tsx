import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  useGroupTemplateMutations: vi.fn(),
  useGroupFileOnServer: vi.fn(),
  postGroupTemplateOps: vi.fn(),
  readGroupTemplate: vi.fn(),
  planningKeys: {
    groupTemplates: ['group-templates'],
    groupTemplate: (id: string) => ['group-templates', id],
  },
}));
vi.mock('@/lib/planning-queries', () => hooks);
vi.mock('@/lib/auth', () => ({
  usePermissions: () => ({ has: () => true }),
  useAuth: () => ({ profile: { id: 'me' } }),
}));
const url = vi.hoisted(() => ({ state: { template: '' }, set: vi.fn() }));
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
  }: {
    initial: { state: ManualState; minutesPerProperty: number };
    onChange: (snapshot: { state: ManualState; minutesPerProperty: number }) => void;
    live?: ManualLive;
  }) {
    const [state, setState] = useState(initial.state);
    useEffect(() => {
      if (!live) return;
      live.controls.current = { rebase: (apply) => setState((current) => apply(current)), setMinutes: () => undefined };
    }, [live]);
    useEffect(() => onChange({ state, minutesPerProperty: 30 }), [onChange, state]);
    return (
      <div data-testid="manual-grouping">
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

function mount({ templates = [{ ...TEMPLATE, groupCount: 1, propertyCount: 2 }] as unknown[], loading = false } = {}) {
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
    url.state = { template: '' };
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

  /** Console-development: the page's name stays while its data loads, rather than a blank skeleton. */
  it('keeps the title while the templates load', () => {
    mount({ loading: true });

    expect(screen.getByRole('heading', { name: 'TBP group maker' })).toBeTruthy();
  });
});
