'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ChevronLeftIcon, ChevronRightIcon, FileTextIcon } from 'lucide-react';

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
const DRAWER_KEY = 'import-dock-drawer';

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
  const router = useRouter();
  const running = useRunningImports();
  const imports = running.data ?? [];
  /**
   * Two different things, and calling both "running" was a lie that cost real
   * work.
   *
   * A reading finishes on its own. A read report does not: it waits at the
   * review step until somebody opens it and presses Import, and until they do
   * the inspection has no areas, no photographs and nothing to compare
   * against. Eleven sat like that — every one an upload somebody believed had
   * landed, because the dialog minimised itself the moment the *file* finished
   * and never asked them back.
   */
  const awaitingReview = imports.filter((job) => job.awaitingReview);
  const stillReading = imports.filter((job) => !job.awaitingReview);

  /**
   * Ask the reader back when a report is ready for them.
   *
   * This is the half that was missing. The dialog minimises itself when the
   * *upload* finishes, which is right — the file is safe and the reading takes
   * minutes. But the reading then ends at a decision only a person can make,
   * and nothing said so. Eleven reports sat parsed and uncommitted, each one an
   * inspection still showing zero areas.
   *
   * Announced once per job, by id. The list is polled every few seconds, so
   * without the ref every poll would re-announce everything already waiting.
   */
  const announced = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const job of awaitingReview) {
      if (announced.current.has(job.id)) continue;
      announced.current.add(job.id);
      toast.info(job.address ? `${job.address} is ready to import` : 'A report is ready to import', {
        description: 'It has been read but not written in yet. Open it and press Import to finish.',
        // Longer than the default: this asks for an action, and a notice that
        // vanishes before it is read is the problem it exists to solve.
        duration: 10_000,
        action: job.inspectionId
          ? {
            label: 'Open',
            onClick: () => router.push(`/inspections/${job.inspectionId}?import=${job.id}`),
          }
          : undefined,
      });
    }
  }, [awaitingReview, router]);
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
  const [open, setOpen] = useState(() => {
    try {
      // Open unless deliberately closed: a first-time import should be seen.
      return window.localStorage.getItem(DRAWER_KEY) !== 'closed';
    } catch {
      return true;
    }
  });

  const toggle = (next: boolean) => {
    setOpen(next);
    try {
      window.localStorage.setItem(DRAWER_KEY, next ? 'open' : 'closed');
    } catch {
      // Preference lost, dock still works. Nothing here is worth an error.
    }
  };

  // Nothing running: render the anchor and no furniture at all. An empty dock
  // is still a rectangle over the corner, and there is nothing to report.
  if (!imports.length)
    return <div className="pointer-events-none fixed right-4 bottom-4 z-50" ref={ref} />;

  /**
   * A drawer, not a panel that is simply gone.
   *
   * Closed, it is a slim handle against the right edge — clear of the corner
   * where this console puts form buttons, but still visible, so an import
   * running in the background is never a secret. Open, it slides the list back
   * out over the page.
   *
   * The handle sits at the vertical middle rather than the bottom corner for
   * the same reason the drawer closes at all: the corner is where the buttons
   * are.
   */
  return (
    <>
      {/* The anchor the minimize animation flies into. Kept mounted and
          independent of open state, so a dialog minimizing into a closed
          drawer still has somewhere to land. */}
      <div className="pointer-events-none fixed right-4 bottom-4 z-50" ref={ref} />

      {!open ? (
        <button
          aria-label={`Show ${imports.length} running import${imports.length === 1 ? '' : 's'}`}
          className={cn(
            'bg-card border-border fixed top-1/2 right-0 z-50 -translate-y-1/2 rounded-l-lg border border-r-0 py-3 pr-1 pl-1.5 shadow-lg',
            'text-muted-foreground hover:text-foreground hover:bg-accent transition-colors',
            'animate-in slide-in-from-right-2 duration-200',
          )}
          onClick={() => toggle(true)}
          type="button"
        >
          <span className="flex flex-col items-center gap-1">
            <ChevronLeftIcon className="size-4" />
            {/* The count, not a spinner: a closed drawer exists to stop pulling
                the eye to the edge, and an animation there defeats that. */}
            <span className="text-[11px] leading-none font-medium tabular-nums">
              {imports.length}
            </span>
          </span>
        </button>
      ) : (
        <div
          className={cn(
            'bg-card/95 border-border fixed top-1/2 right-0 z-50 flex w-80 max-w-[calc(100vw-2rem)] -translate-y-1/2 flex-col gap-2 rounded-l-xl border border-r-0 p-3 shadow-2xl backdrop-blur',
            'animate-in slide-in-from-right duration-200',
          )}
        >
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium">
              {awaitingReview.length ? (
                <span className="text-warning">
                  {awaitingReview.length} need{awaitingReview.length === 1 ? 's' : ''} your review
                </span>
              ) : null}
              {awaitingReview.length && stillReading.length ? (
                <span className="text-muted-foreground"> · </span>
              ) : null}
              {stillReading.length ? (
                <span className="text-muted-foreground">{stillReading.length} reading</span>
              ) : null}
            </p>
            <button
              aria-label="Hide running imports"
              className="text-muted-foreground hover:text-foreground hover:bg-accent -mr-1 rounded p-1 transition-colors"
              onClick={() => toggle(false)}
              type="button"
            >
              <ChevronRightIcon className="size-4" />
            </button>
          </div>
          {[...awaitingReview, ...stillReading].map((job) => (
            <Link
              className={cn(
                'bg-background border-border flex items-center gap-3 rounded-lg border p-3',
                'hover:bg-accent transition-colors',
              )}
              /* Straight to the review, not to the page that contains it.
                 Landing on the inspection left the reader hunting for the
                 button — and on the page they were already on, clicking did
                 nothing visible whatsoever. */
              href={job.inspectionId ? `/inspections/${job.inspectionId}?import=${job.id}` : '#'}
              key={job.id}
            >
              {job.awaitingReview ? (
                <FileTextIcon className="text-muted-foreground size-4 shrink-0" />
              ) : (
                <Spinner className="size-4 shrink-0" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {job.address ?? 'Importing a report'}
                </p>
                <p className={job.awaitingReview ? 'text-warning text-xs' : 'text-muted-foreground text-xs'}>
                  {/* An instruction, not a status. "Waiting for your review"
                      described the row's state and left the reader to work out
                      that nothing happens until they act — which nobody did,
                      eleven times. */}
                  {job.awaitingReview ? 'Open and press Import to finish' : 'Reading the report…'}
                </p>
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
