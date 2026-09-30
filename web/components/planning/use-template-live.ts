'use client';

import type { GroupTemplateEditor, GroupTemplateOpsEvent } from '@texasrenters/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';

import { getSession } from '@/lib/session';

/** A template replaced whole or archived by somebody: read it again. Mirrors the gateway's. */
export interface GroupTemplateReplacedEvent {
  templateId: string;
  revision: number;
  reason: 'SAVED' | 'ARCHIVED' | 'ACTIVATED';
  by: { userId: string; name: string };
}

export interface TemplateLiveHandlers {
  /** A batch the server saved: somebody else's, or this browser's own coming back. */
  onOps: (event: GroupTemplateOpsEvent) => void;
  onPresence: (editors: GroupTemplateEditor[]) => void;
  onReplaced: (event: GroupTemplateReplacedEvent) => void;
  /** In the template's room -- first, or again after the connection dropped -- and the template's revision then. */
  onJoined: (revision: number) => void;
}

/** How long to wait before connecting again after the server hung up: as the console's other live channel does. */
const RECONNECT_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

/**
 * The Group maker's live channel for one template (2026-10-01): its changes as
 * they are saved, and who else has it open. Only listens -- changes go to the
 * server over HTTP -- except to say which group this person is building.
 *
 * The handlers are read through a ref, so a new function each render never
 * drops and rebuilds the connection.
 */
export function useTemplateLive(templateId: string | null, handlers: TemplateLiveHandlers) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, '');
    if (!templateId || !baseUrl) return;
    const socket = io(`${baseUrl}/group-templates`, {
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

    socket.on('ready', () => {
      attempts = 0;
      socket.emit('join', { templateId }, (answer: { ok: boolean; revision?: number }) => {
        if (!answer?.ok) return;
        setConnected(true);
        if (typeof answer.revision === 'number') handlersRef.current.onJoined(answer.revision);
      });
    });
    socket.on('ops', (event: GroupTemplateOpsEvent) => {
      if (event.templateId === templateId) handlersRef.current.onOps(event);
    });
    socket.on('presence', (event: { templateId: string; editors: GroupTemplateEditor[] }) => {
      if (event.templateId === templateId) handlersRef.current.onPresence(event.editors);
    });
    socket.on('replaced', (event: GroupTemplateReplacedEvent) => {
      if (event.templateId === templateId) handlersRef.current.onReplaced(event);
    });
    socket.on('disconnect', (reason) => {
      setConnected(false);
      // socket.io reconnects by itself after the network drops, never after the server hung up.
      if (reason !== 'io server disconnect' || attempts >= RECONNECT_DELAYS_MS.length) return;
      retry = setTimeout(() => socket.connect(), RECONNECT_DELAYS_MS[attempts]);
      attempts += 1;
    });

    return () => {
      clearTimeout(retry);
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
      setConnected(false);
    };
  }, [templateId]);

  /** The group this person is building now, for the others to see. */
  const focus = useCallback((groupId: string | null) => {
    socketRef.current?.emit('focus', { groupId });
  }, []);

  return { connected, focus };
}
