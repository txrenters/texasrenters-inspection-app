import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import type { NavFix, NavigationLeg } from '@texasrenters/shared';

import { announce, type NavAnnouncement, type NavSpeaker } from './announcer';
import { latestNavFix, subscribeToNavFixes } from './nav-fixes';
import {
  INITIAL_NAV_SESSION,
  advanceNavSession,
  skipToNextStop,
  startNavSession,
  stopNavSession,
  type NavDayRoute,
  type NavEffect,
  type NavSessionState,
  type NavSessionStep,
  type NavSessionView,
} from './nav-session';

/**
 * The one place where navigation meets React, the network and the device.
 *
 * Everything that decides anything is in `nav-session.ts` and in `shared`, and
 * it is all pure. This hook does four things and no more: it feeds fixes in, it
 * carries out the effects that come back, it keeps the screen alive, and it
 * re-renders. Put a decision in here and it stops being testable -- that is the
 * whole reason for the split.
 */

/** What the caller must be able to fetch. */
export interface NavLegRequest {
  toStopId: string;
  /** Where to draw from, `[latitude, longitude]`, or null for the last reported position. */
  from: readonly [number, number] | null;
  reason: 'START' | 'REROUTE' | 'NEXT_STOP';
}

export interface UseNavigationSessionOptions {
  /** The day, from `InspectionRepository.route()`. Null while it is loading. */
  dayRoute: NavDayRoute | null;
  /**
   * Fetches the drive to one stop.
   *
   * Injected rather than imported, so the hook does not depend on the shape of
   * `InspectionRepository` and can be driven from a test with a function that
   * returns a fixture. The adapter over the repository is two lines:
   *
   * ```ts
   * fetchLeg: ({ toStopId, from }) =>
   *   repository.navigationLeg(toStopId, { latitude: from[0], longitude: from[1] })
   * ```
   *
   * **`from` is null until the first fix arrives**, which is exactly the case
   * the "start driving" button hits. The repository wants a position, so the
   * adapter supplies the day route's own `origin` there -- that is the position
   * the planner drew the day from, and it is the only one anybody has yet.
   *
   * `null` is an answer, not a failure: the router would not draw this stop.
   * See `requestLeg`, which stops asking rather than retrying it for ever.
   */
  fetchLeg: (request: NavLegRequest) => Promise<NavigationLeg | null>;
  /**
   * Speaks an announcement. **Null in this build** -- speech needs
   * `expo-speech`, a native module an OTA update may not import. See
   * `announcer.ts`; the announcement is shown on screen either way.
   */
  speak?: NavSpeaker | null;
  /** Keep the screen on while driving. Degrades quietly; see below. */
  keepScreenAwake?: boolean;
  onArrived?: (toStopId: string) => void;
  /** Arrived somewhere the chain was not heading for. Reported, never acted on. */
  onArrivedOffPlan?: (toStopId: string) => void;
  onDayComplete?: () => void;
}

export interface NavigationSession {
  view: NavSessionView;
  /** The most recent announcement, for the banner. Cleared when the step changes. */
  announcement: NavAnnouncement | null;
  /** Why the drive could not be fetched. Plain English, for the screen. */
  legError: string | null;
  running: boolean;
  start: (toStopId?: string | null) => void;
  stop: () => void;
  /** Move to the next stop without waiting out the countdown. */
  nextStop: () => void;
}

export function useNavigationSession(
  options: UseNavigationSessionOptions,
): NavigationSession {
  const { dayRoute, keepScreenAwake = true } = options;

  const stateRef = useRef<NavSessionState>(INITIAL_NAV_SESSION);
  const legRef = useRef<NavigationLeg | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [running, setRunning] = useState(false);
  const [announcement, setAnnouncement] = useState<NavAnnouncement | null>(null);
  const [legError, setLegError] = useState<string | null>(null);
  const [view, setView] = useState<NavSessionView>(
    () => stopNavSession(dayRoute, Date.now()).view,
  );

  /**
   * Which leg request is the current one.
   *
   * A reroute asked for at a junction can still be in flight when the driver
   * reaches the next one and a second is asked for. Applying whichever answered
   * last would hand the session a line drawn from a position a quarter of a
   * mile back. Only the newest token's answer is kept.
   */
  const legToken = useRef(0);

  /** Stops the router has already refused to draw. Cleared by `start`. */
  const undrawable = useRef(new Set<string>());

  /**
   * The one-shot deadline for the post-arrival countdown.
   *
   * A `setTimeout`, not a `setInterval`, and it decides nothing: the reducer
   * compares `arrivedAt` against `now` and would reach the same answer if this
   * never fired. Android suspends JavaScript timers in the background, so on a
   * phone in a pocket this one does not fire -- and the `AppState` listener
   * below ticks the session the moment the app comes back, where the timestamp
   * comparison catches up in one step. The timer is a convenience for a screen
   * somebody is looking at; the timestamps are the mechanism.
   */
  const deadline = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearDeadline = useCallback(() => {
    if (deadline.current) clearTimeout(deadline.current);
    deadline.current = null;
  }, []);

  /**
   * Everything below reaches its neighbours through a ref rather than through a
   * dependency array.
   *
   * `apply` carries out effects, an effect starts a fetch, a fetch ticks, and a
   * tick applies -- a cycle that no ordering of `useCallback` declarations can
   * satisfy, and that a dependency array would rebuild on every render, tearing
   * down the fix subscription with it. The refs are the seam that breaks it,
   * and they are always the current render's function.
   */
  const tickRef = useRef<(fix: NavFix | null) => void>(() => {});
  const applyRef = useRef<(step: NavSessionStep) => void>(() => {});
  const runEffectRef = useRef<(effect: NavEffect) => void>(() => {});

  applyRef.current = (step: NavSessionStep) => {
    stateRef.current = step.state;
    setView(step.view);
    setRunning(step.state.phase !== 'IDLE');

    for (const effect of step.effects) runEffectRef.current(effect);

    clearDeadline();
    if (step.view.advanceAtEpochMs !== null) {
      const wait = Math.max(0, step.view.advanceAtEpochMs - Date.now());
      deadline.current = setTimeout(() => tickRef.current(null), wait);
    }
  };

  tickRef.current = (fix: NavFix | null) => {
    if (stateRef.current.phase === 'IDLE' && stateRef.current.targetStopId === null) {
      // Nothing running. A stray fix must not restart a session the technician
      // stopped, or one that finished with the last job of the day.
      return;
    }
    applyRef.current(
      advanceNavSession(stateRef.current, {
        dayRoute: optionsRef.current.dayRoute,
        leg: legRef.current,
        fix,
        now: Date.now(),
      }),
    );
  };

  runEffectRef.current = (effect: NavEffect) => {
    switch (effect.kind) {
      case 'FETCH_LEG':
        // The router has already said it cannot draw this one. The reducer
        // keeps asking because from where it sits a missing leg is always
        // worth another try; the answer only the network has seen belongs
        // here.
        if (undrawable.current.has(effect.toStopId)) return;
        // A reroute or a new stop replaces the line being driven, so the old
        // one is dropped now rather than when the answer arrives: measuring
        // against a line the session has already left behind is exactly the
        // fault `legKey` exists to prevent.
        if (effect.reason !== 'START') legRef.current = null;
        requestLeg(effect);
        return;
      case 'ANNOUNCE':
        setAnnouncement(effect.announcement);
        announce(effect.announcement, optionsRef.current.speak ?? null);
        return;
      case 'ARRIVED':
        optionsRef.current.onArrived?.(effect.toStopId);
        return;
      case 'ARRIVED_OFF_PLAN':
        optionsRef.current.onArrivedOffPlan?.(effect.toStopId);
        return;
      case 'DAY_COMPLETE':
        optionsRef.current.onDayComplete?.();
        return;
    }
  };

  function requestLeg(request: NavLegRequest) {
    legToken.current += 1;
    const token = legToken.current;

    void optionsRef.current
      .fetchLeg(request)
      .then((leg) => {
        if (token !== legToken.current) return;
        if (!leg) {
          // "The router will not draw this stop" is a state to report, not an
          // error to throw -- and not something to ask again every ten seconds
          // for the rest of the shift.
          undrawable.current.add(request.toStopId);
          setLegError('This stop cannot be driven to. Its address may never have been placed.');
          return;
        }
        legRef.current = leg;
        setLegError(null);
        tickRef.current(latestNavFix());
      })
      .catch((error: unknown) => {
        if (token !== legToken.current) return;
        // Kept in plain English, and kept on screen: a technician who cannot
        // get a route needs to know it is the route and not the phone.
        setLegError(
          error instanceof Error && error.message
            ? error.message
            : 'The drive to this stop could not be drawn. It will be tried again.',
        );
      });
  }

  const start = useCallback(
    (toStopId?: string | null) => {
      legRef.current = null;
      legToken.current += 1;
      // A fresh start is the technician saying "try again", which includes the
      // stops the router refused an hour ago -- an address geocoded since then
      // is drawable now.
      undrawable.current = new Set<string>();
      setAnnouncement(null);
      setLegError(null);
      applyRef.current(
        startNavSession(optionsRef.current.dayRoute, {
          now: Date.now(),
          fix: latestNavFix(),
          toStopId: toStopId ?? null,
        }),
      );
    },
    [],
  );

  const stop = useCallback(() => {
    legRef.current = null;
    legToken.current += 1;
    setAnnouncement(null);
    setLegError(null);
    applyRef.current(stopNavSession(optionsRef.current.dayRoute, Date.now()));
  }, []);

  const nextStop = useCallback(() => {
    setAnnouncement(null);
    applyRef.current(
      skipToNextStop(stateRef.current, {
        dayRoute: optionsRef.current.dayRoute,
        leg: legRef.current,
        fix: latestNavFix(),
        now: Date.now(),
      }),
    );
  }, []);

  // Fixes, only while something is running. Subscribing when idle would start
  // the fallback watch in `nav-fixes.ts` for a screen that is not navigating.
  useEffect(() => {
    if (!running) return;
    return subscribeToNavFixes((fix) => tickRef.current(fix));
  }, [running]);

  // The day route can be refetched under a running session -- a stop cancelled,
  // a reordered day -- and the reducer re-checks its refusals on every tick.
  useEffect(() => {
    if (!running) return;
    tickRef.current(latestNavFix());
  }, [dayRoute, running]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next === 'active') tickRef.current(latestNavFix());
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => clearDeadline, [clearDeadline]);

  useKeepAwakeWhileDriving(running && keepScreenAwake);

  return useMemo(
    () => ({ view, announcement, legError, running, start, stop, nextStop }),
    [view, announcement, legError, running, start, stop, nextStop],
  );
}

/**
 * Keeps the screen on while driving, and shrugs when it cannot.
 *
 * `expo-keep-awake` is declared by the `expo` package but is **not installed in
 * `node_modules`** in this workspace. A static import of it would fail to
 * resolve at bundle time, which does not produce a degraded build -- it
 * produces no build. So the module name is assembled at runtime: Metro cannot
 * resolve a non-literal specifier, the import rejects on the handset, and the
 * catch below turns that into "the screen dims", which is a nuisance rather
 * than an outage. The day the package is installed, this starts working with no
 * change here.
 *
 * Released on unmount and on the app going to the background, because a lock
 * held by a screen nobody is looking at is a flat battery in a technician's
 * pocket.
 */
function useKeepAwakeWhileDriving(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    let held = false;
    let dropped = false;

    const activate = async () => {
      const module = await loadKeepAwake();
      if (!module || dropped || held) return;
      try {
        await module.activateKeepAwakeAsync?.(KEEP_AWAKE_TAG);
        held = true;
      } catch {
        // Not available on this build. Nothing to put back.
      }
    };

    const release = () => {
      if (!held) return;
      held = false;
      void loadKeepAwake().then((module) => {
        try {
          void module?.deactivateKeepAwake?.(KEEP_AWAKE_TAG);
        } catch {
          // Already gone, or never held.
        }
      });
    };

    void activate();

    const subscription = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next === 'active') void activate();
      else release();
    });

    return () => {
      dropped = true;
      release();
      subscription.remove();
    };
  }, [active]);
}

const KEEP_AWAKE_TAG = 'texasrenters-navigation';

interface KeepAwakeModule {
  activateKeepAwakeAsync?: (tag?: string) => Promise<void>;
  deactivateKeepAwake?: (tag?: string) => void;
}

let keepAwakeModule: Promise<KeepAwakeModule | null> | null = null;

function loadKeepAwake(): Promise<KeepAwakeModule | null> {
  keepAwakeModule ??= (async () => {
    try {
      // Assembled rather than written out, so no bundler can resolve it. See
      // the note above -- a literal here would break the build outright.
      const name = ['expo', 'keep', 'awake'].join('-');
      return (await import(name)) as KeepAwakeModule;
    } catch {
      return null;
    }
  })();
  return keepAwakeModule;
}
