import { AppState, type AppStateStatus } from 'react-native';

import { isCaptureActive, subscribeToCaptureActivity } from '../media/capture-activity';
import { demoStorageNow } from '../storage/demo-storage';
import { reportError } from './error-log';

/**
 * What the app was doing when last seen, so the next launch can tell a crash
 * from a close.
 *
 * Technicians on iPhones report the app freezing and then closing during
 * move-outs (2026-10-06), and the Error log shows nothing. It cannot: iOS ending
 * an app for memory (jetsam), or for hanging, kills the process outright, and no
 * JavaScript runs to say so. A native crash reporter would need a new build.
 * This needs none. Every change of state is written -- synchronously, so it is
 * on disk whenever the end comes -- and a launch that finds the previous
 * session still marked as running reports how it ended.
 *
 * Writes happen on changes only (foreground/background, a take starting or
 * ending, an upload starting or ending): a few small writes per room, never a
 * timer.
 */

export type SessionActivity = 'idle' | 'recording' | 'uploading';

export interface SessionBreadcrumb {
  /** When this session started, so a report can say how long it ran. */
  startedAt: string;
  /** When the last change was written. */
  at: string;
  /** `restarting`: the app reloading itself on purpose, to apply an update. */
  state: AppStateStatus | 'restarting';
  activity: SessionActivity;
}

const STORAGE_KEY = 'texasrenters-session-breadcrumb-v1';

let current: SessionBreadcrumb | null = null;
let uploading = false;

function activity(): SessionActivity {
  if (isCaptureActive()) return 'recording';
  return uploading ? 'uploading' : 'idle';
}

function write(update: Partial<SessionBreadcrumb>) {
  if (!current) return;
  const next = { ...current, ...update, at: new Date().toISOString() };
  if (next.state === current.state && next.activity === current.activity) return;
  current = next;
  try {
    demoStorageNow.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // A breadcrumb is a diagnostic. Never the reason something else fails.
  }
}

/**
 * Called just before the app reloads itself, so the next launch does not take
 * an update being applied for the app being killed on screen.
 */
export function noteDeliberateRestart(): void {
  write({ state: 'restarting' });
}

/** The upload queue says when a transfer starts and stops; see `tick`. */
export function noteUploading(active: boolean): void {
  if (uploading === active) return;
  uploading = active;
  write({ activity: activity() });
}

const ACTIVITY_WORDS: Record<SessionActivity, string> = {
  idle: 'with nothing running',
  recording: 'while a room was being filmed',
  uploading: 'while a video was uploading',
};

/**
 * What to report about a session that never closed, or null if nothing.
 *
 * In the foreground, it was the system or a crash: nobody can close an app
 * they are looking at without leaving it first, which writes `inactive`. In the
 * background it is ambiguous -- a swipe in the app switcher looks the same as
 * iOS reclaiming memory -- so it is worth a note only mid-take or mid-upload,
 * where the reclaiming is the very thing being looked for.
 */
export function unexpectedExit(
  previous: SessionBreadcrumb | null,
): { message: string; fatal: boolean } | null {
  if (!previous) return null;
  const minutes = Math.max(
    0,
    Math.round((Date.parse(previous.at) - Date.parse(previous.startedAt)) / 60_000),
  );
  const when = `${previous.at}, ${minutes} min into the session`;
  if (previous.state === 'active')
    return {
      message: `The app closed while on screen ${ACTIVITY_WORDS[previous.activity]} (last seen ${when}). The system ended it, or it crashed.`,
      fatal: true,
    };
  if (previous.activity !== 'idle')
    return {
      message: `The app ended in the background ${ACTIVITY_WORDS[previous.activity]} (last seen ${when}). The system may have reclaimed it, or it was swiped away.`,
      fatal: false,
    };
  return null;
}

let installed = false;

/** Reads how the last session ended, then starts recording this one. Safe to call twice. */
export function installSessionBreadcrumb(): void {
  if (installed) return;
  installed = true;

  let previous: SessionBreadcrumb | null = null;
  try {
    const raw = demoStorageNow.getItem(STORAGE_KEY);
    previous = raw ? (JSON.parse(raw) as SessionBreadcrumb) : null;
  } catch {
    previous = null;
  }
  const exit = unexpectedExit(previous);
  if (exit) void reportError(new Error(exit.message), { source: 'unexpected-exit', fatal: exit.fatal });

  const now = new Date().toISOString();
  current = { startedAt: now, at: now, state: AppState.currentState ?? 'active', activity: 'idle' };
  try {
    demoStorageNow.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // As above.
  }

  AppState.addEventListener('change', (state) => write({ state }));
  subscribeToCaptureActivity(() => write({ activity: activity() }));
}
