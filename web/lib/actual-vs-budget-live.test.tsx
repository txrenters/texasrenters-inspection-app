import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { RevenueLiveChange } from '@texasrenters/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GridCell } from '@/components/actual-vs-budget/grid';
import { Table, TableBody, TableRow } from '@/components/ui/table';

import { ActualVsBudgetLive, useActualVsBudgetLive } from './actual-vs-budget-live';

/**
 * Actual vs Budget, live (2026-11-17). The office: "we should make it real time
 * cause there are two roles and users who are going to constantly update it, it
 * should sync all the time like the spreadsheet". Names invented.
 */

type Handler = (...args: never[]) => void;

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, Handler>();
  const urls: string[] = [];
  const socket = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
    },
    emit: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    removeAllListeners: vi.fn(),
  };
  return {
    handlers,
    urls,
    socket,
    io: (url: string) => {
      urls.push(url);
      return socket;
    },
    warning: vi.fn(),
  };
});

vi.mock('socket.io-client', () => ({ io: mocks.io }));
vi.mock('./auth', () => ({ useAuth: () => ({ profile: { id: 'me' } }) }));
vi.mock('./session', () => ({ getSession: async () => ({ accessToken: 'token' }) }));
vi.mock('sonner', () => ({ toast: { warning: mocks.warning, error: vi.fn() } }));

const fire = (event: string, payload: unknown) => act(() => (mocks.handlers.get(event) as unknown as (value: unknown) => void)(payload));
const change = (over: Partial<RevenueLiveChange>): RevenueLiveChange => ({
  scope: 'day',
  cells: [],
  by: { userId: 'kevin', name: 'Kevin Office' },
  at: '2026-11-17T15:00:00.000Z',
  ...over,
});

function Others() {
  const { others } = useActualVsBudgetLive();
  return <p data-testid="others">{others.map((editor) => editor.name).join(', ')}</p>;
}

function mount(client = new QueryClient()) {
  render(
    <QueryClientProvider client={client}>
      <ActualVsBudgetLive view="tracker">
        <Others />
        <Table>
          <TableBody>
            <TableRow>
              <GridCell cell="day:amy:2026-11-11:workSeconds" label="Work time" onCommit={() => true} text="8h 25m" />
              <GridCell cell="day:amy:2026-11-11:dailyRemarks" label="Remarks" onCommit={() => true} text="" />
            </TableRow>
          </TableBody>
        </Table>
      </ActualVsBudgetLive>
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'https://api.example.test');
  mocks.handlers.clear();
  mocks.urls.length = 0;
  mocks.socket.emit.mockClear();
  mocks.warning.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('Actual vs Budget, live', () => {
  it("joins the office's live channel, and says which sheet this person is on", () => {
    mount();
    expect(mocks.urls).toEqual(['https://api.example.test/actual-vs-budget']);
    fire('ready', {});
    expect(mocks.socket.emit).toHaveBeenCalledWith('focus', { view: 'tracker', cell: null });
  });

  it("reads the sheets again once after a burst of others' saves, and not the past logs", async () => {
    vi.useFakeTimers();
    const client = mount();
    const reread = vi.spyOn(client, 'invalidateQueries');
    fire('changed', change({}));
    fire('changed', change({ scope: 'log' }));
    expect(reread).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(reread).toHaveBeenCalledTimes(1);
    const { predicate } = reread.mock.calls[0]![0] as unknown as { predicate: (query: { queryKey: unknown[] }) => boolean };
    expect(predicate({ queryKey: ['actual-vs-budget', 'day', '2026-11-11'] })).toBe(true);
    expect(predicate({ queryKey: ['actual-vs-budget', 'history'] })).toBe(false);
  });

  it('shows the others, not this person, and draws round the cell another is in', () => {
    mount();
    fire('presence', {
      editors: [
        { userId: 'me', name: 'Me Myself', view: 'tracker', cell: 'day:amy:2026-11-11:dailyRemarks' },
        { userId: 'kevin', name: 'Kevin Office', view: 'tracker', cell: 'day:amy:2026-11-11:workSeconds' },
      ],
    });
    expect(screen.getByTestId('others')).toHaveTextContent('Kevin Office');
    expect(screen.getByTestId('others')).not.toHaveTextContent('Me Myself');
    expect(screen.getByLabelText('Kevin Office is in this cell')).toHaveTextContent('KO');
    // Nobody else is in the remarks cell, whatever this person's own cell is.
    expect(screen.getAllByLabelText(/is in this cell/)).toHaveLength(1);
  });

  it('tells the others which cell this person is in, and when they leave it', () => {
    mount();
    fire('ready', {});
    const work = screen.getByLabelText('Work time');
    fireEvent.focus(work);
    expect(mocks.socket.emit).toHaveBeenLastCalledWith('focus', { view: 'tracker', cell: 'day:amy:2026-11-11:workSeconds' });
    fireEvent.blur(work);
    expect(mocks.socket.emit).toHaveBeenLastCalledWith('focus', { view: 'tracker', cell: null });
  });

  it('warns a person when somebody else saves the cell they are typing in, and keeps their typing', () => {
    mount();
    const work = screen.getByLabelText('Work time');
    fireEvent.focus(work);
    fireEvent.change(work, { target: { value: '9h 10m' } });
    fire('changed', change({ cells: ['day:amy:2026-11-11:workSeconds'] }));
    expect(mocks.warning).toHaveBeenCalledWith('Kevin Office just changed this cell', expect.anything());
    expect(work).toHaveValue('9h 10m');
    // Their own save, coming back, is not a warning.
    mocks.warning.mockClear();
    fire('changed', change({ cells: ['day:amy:2026-11-11:workSeconds'], by: { userId: 'me', name: 'Me Myself' } }));
    expect(mocks.warning).not.toHaveBeenCalled();
  });
});
