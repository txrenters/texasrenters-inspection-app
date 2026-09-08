'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { ChevronDownIcon, ChevronUpIcon, FileTextIcon } from 'lucide-react';

import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { useRunningImports } from '@/lib/queries';

/**
 * Where a minimized import goes.
 *
 * Seeding a backlog means starting an import and immediately walking to the
 * next property, so an import that is only visible on the page that started it
 * may as well be invisible. This lives in the shell, above every admin route,
 * so navigating does not lose sight of anything.
 *
 * It is fed by the server rather than by whatever this tab happens to remember.
 * A dock rebuilt from component state would empty itself on reload while the
 * imports carried on — the same class of bug as a job id that lived inside a
 * dialog.
 */

interface DockTarget {
  /** Where a minimizing dialog should fly to, in viewport coordinates. */
  rect: () => DOMRect | null;
  /** Play the flight, then leave the dock to render the real pill. */
  fly: (from: DOMRect) => void;
}

const ImportDockContext = createContext<DockTarget | null>(null);

/** Per-browser preference. Not worth a server round trip or a user row. */
const COLLAPSED_KEY = 'import-dock-collapsed';

/** Lets a dialog hand its own position over so the flight has somewhere to go. */
export const useImportDock = () => useContext(ImportDockContext);

export function ImportDockProvider({ children }: { children: ReactNode }) {
  const dock = useRef<HTMLDivElement>(null);
  const [flight, setFlight] = useState<{ from: DOMRect; to: DOMRect } | null>(null);

  const rect = useCallback(() => dock.current?.getBoundingClientRect() ?? null, []);

  const fly = useCallback((from: DOMRect) => {
    const to = dock.current?.getBoundingClientRect();
    // No dock on screen — nothing to fly to, and an animation into empty space
    // reads as a glitch. The pill simply appears instead.
    if (!to) return;
    setFlight({ from, to });
  }, []);

  return (
    <ImportDockContext.Provider value={{ rect, fly }}>
      {children}
      {flight ? <Flight {...flight} onDone={() => setFlight(null)} /> : null}
      <ImportDock ref={dock} />
    </ImportDockContext.Provider>
  );
}

/**
 * The card, travelling.
 *
 * Driven by the Web Animations API rather than CSS keyframes because the
 * distance is not known until it is flown: both ends are measured rects, and a
 * stylesheet cannot know where a dialog happened to be.
 *
 * `prefers-reduced-motion` skips straight to the end. The animation is
 * decoration — the pill it lands on is the information.
 */
function Flight({ from, to, onDone }: { from: DOMRect; to: DOMRect; onDone: () => void }) {
  const ghost = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ghost.current;
    if (!node) {
      onDone();
      return;
    }
    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      onDone();
      return;
    }

    const animation = node.animate(
      [
        { transform: 'translate(0, 0) scale(1)', opacity: 0.95 },
        {
          transform: `translate(${to.left + to.width / 2 - (from.left + from.width / 2)}px, ${
            to.top + to.height / 2 - (from.top + from.height / 2)
          }px) scale(0.12)`,
          opacity: 0.2,
        },
      ],
      {
        duration: 420,
        // Leaves quickly and settles into the dock, rather than easing out of
        // the dialog as though it were reluctant to go.
        easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
        fill: 'forwards',
      },
    );
    animation.onfinish = onDone;
    animation.oncancel = onDone;
    return () => animation.cancel();
  }, [from, to, onDone]);

  return (
    <div
      aria-hidden
      className="bg-card border-border pointer-events-none fixed z-[100] rounded-lg border shadow-lg"
      ref={ghost}
      style={{ left: from.left, top: from.top, width: from.width, height: from.height }}
    />
  );
}

/**
 * The pills themselves.
 *
 * Bottom right rather than a corner of the page content: it has to sit above
 * whatever route is mounted, and it must not push layout around when an import
 * starts or finishes.
 */
function ImportDock({ ref }: { ref: React.Ref<HTMLDivElement> }) {
  const running = useRunningImports();
  const imports = running.data ?? [];
  /**
   * Collapsed by choice, and the choice sticks.
   *
   * The expanded dock sits over the bottom-right corner, which is where this
   * console puts the buttons on almost every form — so an import running in
   * the background made those buttons unclickable. A progress indicator that
   * blocks the work it is reporting on is worse than no indicator.
   *
   * Read lazily and wrapped, because storage throws outright in a private
   * window and in some embedded contexts. A dock that cannot remember the
   * preference is a much smaller problem than one that crashes the shell.
   */
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(COLLAPSED_KEY) === 'true';
    } catch {
      return false;
    }
  });

  const toggle = (next: boolean) => {
    setCollapsed(next);
    try {
      window.localStorage.setItem(COLLAPSED_KEY, String(next));
    } catch {
      // Preference lost, dock still works. Nothing here is worth an error.
    }
  };

  // Nothing running: render the anchor and no furniture at all. An empty dock
  // is still a rectangle over the corner, and there is nothing to report.
  if (!imports.length)
    return <div className="pointer-events-none fixed right-4 bottom-4 z-50" ref={ref} />;

  if (collapsed)
    return (
      <div className="fixed right-4 bottom-4 z-50" ref={ref}>
        <button
          aria-label={`Show ${imports.length} running import${imports.length === 1 ? '' : 's'}`}
          className={cn(
            'bg-card border-border text-muted-foreground flex items-center gap-1.5 rounded-full border py-1.5 pr-3 pl-2 shadow-lg',
            'hover:text-foreground hover:bg-accent transition-colors',
          )}
          onClick={() => toggle(false)}
          type="button"
        >
          <ChevronUpIcon className="size-3.5" />
          {/* The count, not a spinner: collapsed is for getting out of the way,
              and a spinner in the corner pulls the eye back to it. */}
          <span className="text-xs font-medium tabular-nums">{imports.length}</span>
        </button>
      </div>
    );

  return (
    <div
      className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-72 flex-col items-end gap-2"
      ref={ref}
    >
      <button
        aria-label="Hide running imports"
        className={cn(
          'bg-card border-border text-muted-foreground pointer-events-auto flex items-center gap-1.5 rounded-full border py-1 pr-2.5 pl-2 shadow-lg',
          'hover:text-foreground hover:bg-accent transition-colors',
        )}
        onClick={() => toggle(true)}
        type="button"
      >
        <ChevronDownIcon className="size-3.5" />
        <span className="text-xs">Hide</span>
      </button>
      {imports.map((job) => (
        <Link
          className={cn(
            'bg-card border-border pointer-events-auto flex w-full items-center gap-3 rounded-lg border p-3 shadow-lg',
            'hover:bg-accent transition-colors',
            'animate-in slide-in-from-right-4 fade-in duration-300',
          )}
          href={job.inspectionId ? `/inspections/${job.inspectionId}` : '#'}
          key={job.id}
        >
          {job.awaitingReview ? (
            <FileTextIcon className="text-muted-foreground size-4 shrink-0" />
          ) : (
            <Spinner className="size-4 shrink-0" />
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{job.address ?? 'Importing a report'}</p>
            <p className="text-muted-foreground text-xs">
              {/* Two different waits, and the difference matters: one finishes
                  on its own, the other needs somebody to look at it. */}
              {job.awaitingReview ? 'Read — waiting for your review' : 'Reading the report…'}
            </p>
          </div>
        </Link>
      ))}
    </div>
  );
}
