'use client';

import { useQueryClient } from '@tanstack/react-query';
import type { RevenueLiveChange, RevenueLiveEditor } from '@texasrenters/shared';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { io, type Socket } from 'socket.io-client';
import { toast } from 'sonner';

import { actualVsBudgetKeys } from './actual-vs-budget-queries';
import { useAuth } from './auth';
import { getSession } from './session';

/**
 * Actual vs Budget, live (2026-11-17; the office: "we should make it real time
 * cause there are two roles and users who are going to constantly update it, it
 * should sync all the time like the spreadsheet").
 *
 * One connection for the page. Every save anybody makes is told here, and the
 * sheet on screen reads itself again -- only the sheet on screen: React Query
 * refetches what is shown and marks the rest stale. Which cell each other
 * person is in is told too, and drawn round that cell. A cell somebody is
 * typing in is never overwritten while they type (the grid only takes a new
 * value once it is left); if somebody else saves it meanwhile, they are told.
 *
 * Only listens, and says where this person is. Every change goes to the
 * server over HTTP, as before.
 */

/** As the console's other live channels: after the server hangs up, try again after these. */
const RECONNECT_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000];
/** Saves in a burst -- a pasted row, a quick run of cells -- read the sheet once. */
const REREAD_AFTER_MS = 250;

interface LiveState {
  connected: boolean;
  /** Everyone else with the page open, one entry a person. */
  others: RevenueLiveEditor[];
  /** The others' cells: cell -> the person in it. */
  cellOwners: Map<string, RevenueLiveEditor>;
  /** This person is now in a cell -- or none. */
  focusCell: (cell: string | null) => void;
}

const NOBODY: LiveState = { connected: false, others: [], cellOwners: new Map(), focusCell: () => undefined };
const LiveContext = createContext<LiveState>(NOBODY);

export function ActualVsBudgetLive({ view, children }: { view: string; children: ReactNode }) {
  const client = useQueryClient();
  const { profile } = useAuth();
  const me = profile?.id ?? null;
  const socketRef = useRef<Socket | null>(null);
  const viewRef = useRef(view);
  const cellRef = useRef<string | null>(null);
  const meRef = useRef(me);
  meRef.current = me;
  const [connected, setConnected] = useState(false);
  const [editors, setEditors] = useState<RevenueLiveEditor[]>([]);

  useEffect(() => {
    const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, '');
    if (!baseUrl) return;
    const socket = io(`${baseUrl}/actual-vs-budget`, {
      transports: ['websocket'],
      // Asked for on every attempt, so a reconnect an hour later offers a fresh token.
      auth: (deliver) => {
        void getSession()
          .catch(() => null)
          .then((session) => deliver({ accessToken: session?.accessToken ?? '' }));
      },
    });
    socketRef.current = socket;
    let attempts = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let reread: ReturnType<typeof setTimeout> | undefined;
    const readAgain = (history: boolean) => {
      clearTimeout(reread);
      reread = setTimeout(() => {
        void client.invalidateQueries({
          queryKey: actualVsBudgetKeys.all,
          // The past logs never change but by an import.
          predicate: (query) => history || query.queryKey[1] !== 'history',
        });
      }, REREAD_AFTER_MS);
    };

    socket.on('ready', () => {
      attempts = 0;
      setConnected(true);
      socket.emit('focus', { view: viewRef.current, cell: cellRef.current });
      // Whatever was saved while the connection was down.
      readAgain(false);
    });
    socket.on('changed', (change: RevenueLiveChange) => {
      readAgain(change.scope === 'history');
      const mine = cellRef.current;
      if (change.by.userId !== meRef.current && mine && change.cells.includes(mine))
        toast.warning(`${change.by.name} just changed this cell`, { description: 'Your typing is kept until you leave the cell; saving it replaces theirs.' });
    });
    socket.on('presence', (event: { editors: RevenueLiveEditor[] }) => setEditors(event.editors));
    socket.on('disconnect', (reason) => {
      setConnected(false);
      // socket.io reconnects by itself after the network drops, never after the server hung up.
      if (reason !== 'io server disconnect' || attempts >= RECONNECT_DELAYS_MS.length) return;
      retry = setTimeout(() => socket.connect(), RECONNECT_DELAYS_MS[attempts]);
      attempts += 1;
    });

    return () => {
      clearTimeout(retry);
      clearTimeout(reread);
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
      setConnected(false);
    };
  }, [client]);

  // A new sheet: the cell left behind is no longer this person's.
  useEffect(() => {
    viewRef.current = view;
    cellRef.current = null;
    socketRef.current?.emit('focus', { view, cell: null });
  }, [view]);

  const focusCell = useCallback((cell: string | null) => {
    if (cellRef.current === cell) return;
    cellRef.current = cell;
    socketRef.current?.emit('focus', { view: viewRef.current, cell });
  }, []);

  const value = useMemo<LiveState>(() => {
    const others = editors.filter((editor) => editor.userId !== me);
    const cellOwners = new Map<string, RevenueLiveEditor>();
    for (const editor of others) if (editor.cell) cellOwners.set(editor.cell, editor);
    return { connected, others, cellOwners, focusCell };
  }, [connected, editors, me, focusCell]);

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export const useActualVsBudgetLive = () => useContext(LiveContext);

/** A person's initials, for the row of faces and a cell's tag. */
export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('');

/** The same colour for a person on every screen, from their id. */
export function editorColour(userId: string): string {
  const hues = [210, 140, 25, 280, 340, 180, 50];
  let hash = 0;
  for (const character of userId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return `hsl(${hues[hash % hues.length]} 70% 45%)`;
}
