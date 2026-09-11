'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { AlertTriangleIcon, ChevronLeftIcon, ChevronRightIcon, FileTextIcon } from 'lucide-react';

import { Progress } from '@/components/ui/progress';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { useAdminMutations, useRunningImports } from '@/lib/queries';

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

/** An upload the drawer is carrying on somebody's behalf. */
interface DockUpload {
  inspectionId: string;
  address: string | null;
  /** 0 to 1, or null before the first progress event. */
  progress: number | null;
  error?: string;
}

interface DockTarget {
  /** Where a minimizing dialog should fly to, in viewport coordinates. */
  rect: () => DOMRect | null;
  /** Play the flight, then leave the dock to render the real pill. */
  fly: (from: DOMRect) => void;
  /**
   * Take the file and carry it.
   *
   * The upload used to live inside the dialog, which is why the dialog could
   * not be closed while it ran: closing it took the only progress display with
   * it. Hoisting it here lets the dialog hand the file over and get out of the
   * way immediately — the drawer reports the bytes, and the server takes over
   * from there.
   */
  upload: (input: { inspectionId: string; address: string | null; file: File }) => void;
}

const ImportDockContext = createContext<DockTarget | null>(null);

/** Per-browser preference. Not worth a server round trip or a user row. */
const DRAWER_KEY = 'import-dock-drawer';

/** Lets a dialog hand its own position over so the flight has somewhere to go. */
export const useImportDock = () => useContext(ImportDockContext);

export function ImportDockProvider({ children }: { children: ReactNode }) {
  const dock = useRef<HTMLDivElement>(null);
  const [flight, setFlight] = useState<{ from: DOMRect; to: DOMRect } | null>(null);
  /**
   * Uploads in flight, keyed by inspection.
   *
   * Held here rather than in the dialog so closing the dialog does not abandon
   * the display. The request itself always survived — an XHR is not tied to
   * the component that started it — but the progress had nowhere to go, which
   * is why the dialog had to stay open and could not be dismissed.
   */
  const [uploads, setUploads] = useState<Record<string, DockUpload>>({});
  const { startInspectionImport } = useAdminMutations();

  const rect = useCallback(() => dock.current?.getBoundingClientRect() ?? null, []);

  const upload = useCallback(
    ({ inspectionId, address, file }: { inspectionId: string; address: string | null; file: File }) => {
      setUploads((held) => ({ ...held, [inspectionId]: { inspectionId, address, progress: 0 } }));
      void startInspectionImport
        .mutateAsync({
          inspectionId,
          file,
          onProgress: (fraction) =>
            setUploads((held) =>
              // Only if this upload is still the one being tracked. A second
              // attempt on the same inspection replaces the first, and a late
              // progress event from the abandoned one must not resurrect it.
              held[inspectionId] ? { ...held, [inspectionId]: { ...held[inspectionId], progress: fraction } } : held,
            ),
        })
        .then(() => {
          // Handed to the server. From here the polled job list is the truth,
          // so the local record steps aside rather than duplicating a row.
          setUploads((held) => {
            const rest = { ...held };
            delete rest[inspectionId];
            return rest;
          });
        })
        .catch((error: unknown) => {
          // Kept visible. A failed upload is the one part of this nobody else
          // will report — there is no job row for a file that never landed.
          setUploads((held) => ({
            ...held,
            [inspectionId]: {
              inspectionId,
              address,
              progress: null,
              error: error instanceof Error ? error.message : 'The upload failed.',
            },
          }));
        });
    },
    [startInspectionImport],
  );

  const fly = useCallback((from: DOMRect) => {
    const to = dock.current?.getBoundingClientRect();
    // No dock on screen — nothing to fly to, and an animation into empty space
    // reads as a glitch. The pill simply appears instead.
    if (!to) return;
    setFlight({ from, to });
  }, []);

  return (
    <ImportDockContext.Provider value={{ rect, fly, upload }}>
      {children}
      {flight ? <Flight {...flight} onDone={() => setFlight(null)} /> : null}
      <ImportDock ref={dock} uploads={Object.values(uploads)} />
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
function ImportDock({ ref, uploads }: { ref: React.Ref<HTMLDivElement>; uploads: DockUpload[] }) {
  const router = useRouter();
  const running = useRunningImports();
  const imports = running.data ?? [];
  /**
   * Everything still in motion: files going up, then reports being read.
   *
   * There is no third state any more. A read report is written in immediately,
   * so nothing sits waiting on a person — which is what left eleven
   * inspections showing zero areas, each one an upload somebody believed had
   * landed.
   */
  const reading = imports.filter((job) => job.state === 'READING');
  const inFlight = uploads.length + reading.length;

  /**
   * Says when an import has landed, and what landed.
   *
   * This replaces asking somebody to come back and press Import. A read report
   * is written in as soon as it is read, so the only thing left to do is tell
   * whoever started it — they are on the next property by then, and the
   * inspection they left has quietly filled in behind them.
   *
   * Announced once per job. The list is polled every few seconds and a finished
   * job stays in it for a short window, so without the ref every poll would
   * repeat itself.
   */
  const announced = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const job of imports) {
      if (job.state === 'READING' || announced.current.has(job.id)) continue;
      announced.current.add(job.id);
      /**
       * `?import=` is this branch's whole point: the row opens the *review* for
       * that job rather than the inspection page it happens to sit near.
       *
       * Kept on top of main's success/failure split rather than instead of it.
       * The two changes answer different questions -- which page the link goes
       * to, and whether the notice says the import worked -- and taking either
       * side whole would silently drop the other.
       */
      const open = job.inspectionId
        ? {
            label: 'Open',
            onClick: () =>
              router.push(`/inspections/${job.inspectionId}?import=${job.id}`),
          }
        : undefined;

      if (job.state === 'IMPORTED')
        toast.success(job.address ? `${job.address} imported` : 'Report imported', {
          description: 'The areas, photographs and condition are on the inspection now.',
          duration: 10_000,
          action: open,
        });
      // A failure is worth the same interruption. Silently dropping the row
      // would leave somebody believing an import happened — which is the whole
      // failure this feature has been fixing.
      else
        toast.error(job.address ? `${job.address} could not be imported` : 'Import failed', {
          description: job.errorCode ?? 'The report could not be read.',
          duration: 10_000,
          action: open,
        });
    }
  }, [imports, router]);
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
      /**
       * Closed unless deliberately opened.
       *
       * It used to be the other way round, on the reasoning that a first-time
       * import should be seen — which held only while the dock rendered nothing
       * at all when nothing was running. Now the handle is always there, so
       * "open by default" means a panel sitting over the right-hand side of
       * every page from the first load, saying that nothing is happening.
       *
       * Nothing is lost by starting closed: a finished import announces itself
       * with a notification, and the handle carries the count of anything still
       * moving.
       */
      return window.localStorage.getItem(DRAWER_KEY) === 'open';
    } catch {
      return false;
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

  /**
   * Opens itself when somebody hands a file over here.
   *
   * The dialog closes the moment it has the file, so without this the whole
   * visible result of choosing a report is a dialog disappearing — the bytes
   * go up behind a closed drawer with a small number on it. That is the
   * complaint this drawer was built to fix, reintroduced from the other side.
   *
   * Only on an upload started in *this* tab, and only on the transition from
   * none to some. An import appearing from a colleague's session is worth a
   * count on the handle, not a panel opening over whatever the reader is
   * doing, and re-firing while an upload continued would fight anybody who
   * closed it deliberately.
   *
   * The preference is deliberately not written: this is a reaction to one
   * action, not a new default.
   */
  const uploading = uploads.length;
  const wasUploading = useRef(0);
  useEffect(() => {
    if (uploading > 0 && wasUploading.current === 0) setOpen(true);
    wasUploading.current = uploading;
  }, [uploading]);

  /**
   * A drawer that is always there, whether or not anything is running.
   *
   * It used to render nothing at all when idle, on the reasoning that an empty
   * dock is still a rectangle over the corner. True of a *panel*, and it made
   * the drawer unfindable: the only way to see running imports was to already
   * have one running, so somebody who started an import, navigated away and
   * came back had no way to ask what had happened to it. A control that exists
   * only while it has something to say cannot be looked at.
   *
   * Closed, it is a slim handle against the right edge — clear of the corner
   * where this console puts form buttons, but always visible, so an import
   * running in the background is never a secret and the way to check is always
   * in the same place. Open, it slides the list out over the page, with an
   * empty state rather than nothing when there is nothing to show.
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
          aria-label={
            inFlight
              ? `Show ${inFlight} import${inFlight === 1 ? '' : 's'} in progress`
              : 'Show imports'
          }
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
                the eye to the edge, and an animation there defeats that.

                An icon when there is no count, rather than a "0". A zero is a
                number worth reading, and reading it tells you nothing — the
                icon says what the handle is for, which is the only thing an
                idle handle has to communicate. */}
            {inFlight ? (
              <span className="text-[11px] leading-none font-medium tabular-nums">{inFlight}</span>
            ) : (
              <FileTextIcon className="size-3.5" />
            )}
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
            <p className="text-muted-foreground text-xs font-medium">
              {inFlight ? `${inFlight} import${inFlight === 1 ? '' : 's'} in progress` : 'Imports'}
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
          {uploads.map((item) => (
            <div
              className="bg-background border-border flex items-center gap-3 rounded-lg border p-3"
              key={item.inspectionId}
            >
              {item.error ? (
                <AlertTriangleIcon className="text-destructive size-4 shrink-0" />
              ) : (
                <Spinner className="size-4 shrink-0" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{item.address ?? 'Uploading a report'}</p>
                <p className={item.error ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'}>
                  {item.error ??
                    (item.progress === null
                      ? 'Uploading…'
                      : `Uploading… ${Math.round(item.progress * 100)}%`)}
                </p>
                {/* Only while bytes are moving. A full bar during the read
                    would claim progress that is not being made. */}
                {!item.error && item.progress !== null ? (
                  <Progress className="mt-1.5 h-1" value={Math.round(item.progress * 100)} />
                ) : null}
              </div>
            </div>
          ))}
          {reading.map((job) => (
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
                <p className="text-muted-foreground text-xs">
                  {/* Nothing to instruct any more: it applies itself. */}
                  Reading the report…
                </p>
              </div>
            </Link>
          ))}
          {/* An empty state rather than an empty box.

              Opening the drawer is a question — "is anything still going?" —
              and a blank panel does not answer it. Worse, it reads as broken:
              the reader cannot tell "nothing is running" from "this failed to
              load". Saying so also tells somebody who has never started an
              import what the drawer is for. */}
          {!inFlight ? (
            <div className="border-border/60 rounded-lg border border-dashed p-4 text-center">
              <p className="text-muted-foreground text-xs">No imports running.</p>
              <p className="text-muted-foreground/70 mt-1 text-[11px]">
                Reports you import appear here until they finish.
              </p>
            </div>
          ) : null}
        </div>
      )}
    </>
  );
}
