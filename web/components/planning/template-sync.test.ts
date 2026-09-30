import { applyGroupOps, diffGroupOps, sameGroups, type GroupTemplateOp, type LiveGroup, type LiveGroups } from '@texasrenters/shared';
import { describe, expect, it } from 'vitest';

import { TemplateSync, type SyncStatus } from './template-sync';

/**
 * Two people on one live template (the office, 2026-10-01): each sees what the
 * other does, and they end up with the same groups as the server.
 */

const group = (id: string, stops: string[], extra: Partial<LiveGroup<string>> = {}): LiveGroup<string> => ({
  id,
  name: `Group ${id}`,
  color: '#e6194b',
  target: 9,
  stops,
  ...extra,
});

const BASE: LiveGroups<string> = { groups: [group('a', ['p1', 'p2']), group('b', ['p3'])] };

let ids = 0;
const newId = () => `batch-${(ids += 1)}`;
const flushAll = async () => {
  for (let round = 0; round < 20; round += 1) await Promise.resolve();
};

/** The server: applies each batch in turn and tells every browser, its sender included. */
class FakeServer {
  state = BASE;
  revision = 1;
  browsers: Browser[] = [];
  /** Browsers that do not hear the next broadcast: a dropped live channel. */
  deaf = new Set<Browser>();
  refuse: string | null = null;
  failNext = 0;

  async post(from: Browser, batchId: string, ops: GroupTemplateOp<string>[]) {
    await Promise.resolve();
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('network');
    }
    if (this.refuse) throw Object.assign(new Error(this.refuse), { refused: true });
    this.state = applyGroupOps(this.state, ops);
    this.revision += 1;
    const event = { revision: this.revision, batchId, ops };
    for (const browser of this.browsers) if (!this.deaf.has(browser)) browser.sync.received(event);
    this.deaf.clear();
    void from;
    return { revision: this.revision };
  }
}

class Browser {
  view: LiveGroups<string> = BASE;
  statuses: SyncStatus['kind'][] = [];
  timers: (() => void)[] = [];
  sync: TemplateSync;

  constructor(
    private readonly server: FakeServer,
    visible?: (groups: LiveGroups<string>) => LiveGroups<string>,
  ) {
    server.browsers.push(this);
    this.sync = new TemplateSync({
      ...(visible ? { visible } : {}),
      base: BASE,
      revision: 1,
      post: (batchId, ops) => server.post(this, batchId, ops),
      fetch: async () => ({ groups: server.state, revision: server.revision }),
      view: () => this.view,
      applyToView: (ops) => {
        this.view = applyGroupOps(this.view, ops);
      },
      onStatus: (status) => this.statuses.push(status.kind),
      newId,
      refused: (error) => ((error as { refused?: boolean }).refused ? (error as Error).message : null),
      sleep: async () => undefined,
      setTimer: (run) => this.timers.push(run),
      clearTimer: () => {
        this.timers = [];
      },
    });
  }

  /** What this person does: their view changes at once, and the change goes out. */
  edit(change: (groups: LiveGroups<string>) => LiveGroups<string>) {
    const next = change(this.view);
    const ops = diffGroupOps(this.view, next);
    this.view = next;
    this.sync.local(ops);
  }
}

const withStop = (groupId: string, stop: string) => (state: LiveGroups<string>) => applyGroupOps(state, [{ type: 'stop.add', groupId, stop }]);

describe('a live template', () => {
  it('shows one person what the other just did', async () => {
    const server = new FakeServer();
    const ernie = new Browser(server);
    const maria = new Browser(server);

    ernie.edit(withStop('a', 'p9'));
    await flushAll();

    expect(maria.view.groups[0]!.stops).toEqual(['p1', 'p2', 'p9']);
    expect(sameGroups(ernie.view, server.state)).toBe(true);
    expect(sameGroups(maria.view, server.state)).toBe(true);
    expect(ernie.statuses.at(-1)).toBe('saved');
  });

  it('keeps what both did when they edit at the same moment', async () => {
    const server = new FakeServer();
    const ernie = new Browser(server);
    const maria = new Browser(server);

    ernie.edit(withStop('a', 'p9'));
    maria.edit((state) => applyGroupOps(state, [{ type: 'stops.order', groupId: 'a', stops: ['p2', 'p1'] }]));
    maria.edit(withStop('b', 'p8'));
    await flushAll();

    expect(server.state.groups.map((entry) => entry.stops)).toEqual([
      ['p2', 'p1', 'p9'],
      ['p3', 'p8'],
    ]);
    expect(sameGroups(ernie.view, server.state)).toBe(true);
    expect(sameGroups(maria.view, server.state)).toBe(true);
  });

  it('ends with the same names when both make "Group 3" at once', async () => {
    const server = new FakeServer();
    const ernie = new Browser(server);
    const maria = new Browser(server);

    ernie.edit((state) => ({ groups: [...state.groups, group('x', [], { name: 'Group 3' })] }));
    maria.edit((state) => ({ groups: [...state.groups, group('y', [], { name: 'Group 3' })] }));
    await flushAll();

    expect(server.state.groups.map((entry) => entry.name).sort()).toEqual(['Group 3', 'Group 4', 'Group a', 'Group b']);
    expect(sameGroups(ernie.view, server.state)).toBe(true);
    expect(sameGroups(maria.view, server.state)).toBe(true);
  });

  it('reads the template again when a change never arrived', async () => {
    const server = new FakeServer();
    const ernie = new Browser(server);
    const maria = new Browser(server);

    server.deaf.add(maria);
    ernie.edit(withStop('a', 'p9'));
    await flushAll();
    ernie.edit(withStop('b', 'p7'));
    await flushAll();

    // Maria heard the second change but not the first: she waits, then reads the template.
    expect(maria.view.groups[0]!.stops).toEqual(['p1', 'p2']);
    expect(maria.timers).toHaveLength(1);
    maria.timers[0]!();
    await flushAll();
    expect(sameGroups(maria.view, server.state)).toBe(true);
  });

  it('puts back what the server refused, and says why', async () => {
    const server = new FakeServer();
    const ernie = new Browser(server);

    server.refuse = 'This template has been archived.';
    ernie.edit(withStop('a', 'p9'));
    await flushAll();

    expect(ernie.statuses).toContain('refused');
    expect(sameGroups(ernie.view, server.state)).toBe(true);
    expect(ernie.view.groups[0]!.stops).toEqual(['p1', 'p2']);
  });

  it('sends a change again after the network failed, and says so meanwhile', async () => {
    const server = new FakeServer();
    const ernie = new Browser(server);

    server.failNext = 2;
    ernie.edit(withStop('a', 'p9'));
    await flushAll();

    expect(ernie.statuses).toEqual(['saving', 'offline', 'offline', 'saved']);
    expect(server.state.groups[0]!.stops).toEqual(['p1', 'p2', 'p9']);
    expect(ernie.sync.pending).toBe(false);
  });

  it('never shows a property this browser does not draw, nor keeps trying to', async () => {
    const server = new FakeServer();
    const ernie = new Browser(server);
    const hidden = (groups: LiveGroups<string>) => ({
      groups: groups.groups.map((entry) => ({ ...entry, stops: entry.stops.filter((stop) => stop !== 'p99') })),
    });
    const narrow = new Browser(server, hidden);
    // Its view is what it can draw: the property it cannot is never in it.
    const applied: number[] = [];
    const original = narrow.sync as unknown as { deps: { applyToView: (ops: GroupTemplateOp<string>[]) => void } };
    const apply = original.deps.applyToView;
    original.deps.applyToView = (ops) => {
      applied.push(ops.length);
      apply(ops.flatMap((op) => (op.type === 'stop.add' && op.stop === 'p99' ? [] : [op])));
    };

    ernie.edit(withStop('b', 'p99'));
    await flushAll();
    ernie.edit(withStop('a', 'p9'));
    await flushAll();

    expect(narrow.view.groups.map((entry) => entry.stops)).toEqual([['p1', 'p2', 'p9'], ['p3']]);
    // Each of Ernie's changes reached it once; it never went on trying to add what it cannot draw.
    expect(applied).toEqual([1, 1]);
  });
});
