'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertTriangleIcon, CheckCircle2Icon, FileTextIcon, UploadIcon } from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useImportDock } from '@/components/import-dock';
import { humanize } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  useActiveInspectionImport,
  useAdminMutations,
  useInspectionImportJob,
  type ImportJob,
} from '@/lib/queries';

/**
 * The way in, from the inspection that needs filling.
 *
 * Shown on an inspection Jobber closed and nothing was ever recorded against --
 * the walk happened in another system, so the record arrives here complete and
 * empty -- and equally on one whose record here is simply wrong. The import
 * replaces what it finds either way; `replacing` is what makes that plain
 * before a file is chosen rather than after.
 *
 * A dialog rather than a panel: this is done once per inspection, and a
 * permanent block on a page people read repeatedly costs more attention than
 * it earns.
 */
export function ImportReportDialog({
  inspectionId,
  inspectionType,
  propertyLabel,
  replacing = false,
}: {
  inspectionId: string;
  /** Named in the drawer while it uploads, so a row is not just a spinner. */
  propertyLabel?: string | null;
  /** Only shapes the wording. Every type is importable; the one rule that
   * decides is having a property, which is not about type. */
  inspectionType?: string | null;
  /**
   * Whether there is evidence here for the import to overwrite.
   *
   * Defaults to false, and the caller that knows passes the answer. Getting it
   * wrong in this direction promises a clean fill on a record about to be
   * replaced, which is the mistake worth a prop.
   */
  replacing?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const kind = inspectionType ? humanize(inspectionType).toLowerCase() : 'inspection';

  /**
   * Opened straight from the drawer, not merely navigated near.
   *
   * A drawer row used to link to the inspection and stop there, leaving the
   * reader to find the button that opens this. If they were already on the
   * page it was a no-op navigation and nothing visibly happened at all — which
   * is what eleven un-imported reports looked like from the outside.
   *
   * Read once into state rather than driving `open` from the URL, so closing
   * the dialog does not fight a parameter that is still in the address bar.
   */
  const requestedImport = useSearchParams().get('import');
  const openedFromLink = useRef(false);
  useEffect(() => {
    if (!requestedImport || openedFromLink.current) return;
    openedFromLink.current = true;
    setOpen(true);
  }, [requestedImport]);
  /**
   * Asked of the inspection, not remembered from this dialog.
   *
   * Both halves of an import run detached on the server and finish whether or
   * not anybody is looking. The job id used to live only in this component,
   * though, so closing the dialog lost the handle and the import *looked*
   * abandoned — which is why these were run one at a time. Now the dialog can
   * be closed, another property started, and this one reopened where it was.
   */
  const active = useActiveInspectionImport(inspectionId);
  const running = isRunning(active.data);
  const dock = useImportDock();
  const content = useRef<HTMLDivElement>(null);

  /**
   * Gets out of the way the moment the file has landed.
   *
   * Everything after the upload happens on the server, so the dialog has
   * nothing left to say — and leaving it open is what had these run one at a
   * time. It flies into the dock instead, which is both the exit and the
   * explanation: the work went over there, and it is still going.
   *
   * The rect is read before the dialog closes, because a closed dialog has no
   * position to fly from.
   */
  const handOff = useCallback(
    (file: File) => {
      // Read before closing: a closed dialog has no position to fly from.
      const from = content.current?.getBoundingClientRect();
      dock?.upload({ inspectionId, address: propertyLabel ?? null, file });
      if (from) dock?.fly(from);
      setOpen(false);
    },
    [dock, inspectionId, propertyLabel],
  );

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger asChild>
        <Button variant="outline">
          {running ? <Spinner /> : <UploadIcon />}
          {running ? 'Import in progress' : 'Import a report'}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-3xl" ref={content}>
        <DialogHeader>
          <DialogTitle>{replacing ? 'Replace this inspection’s evidence' : 'Import an inspection report'}</DialogTitle>
          <DialogDescription>
            {/* Two different things to say, and the difference matters more
                than the wording of either. On an empty record this explains why
                the import exists; on one holding evidence it is the warning,
                and the last point at which the reader can stop.

                The baseline argument is true of a move-in and only a move-in.
                Saying it over a move-out would be explaining the wrong reason
                for doing the right thing. */}
            {replacing ? (
              <>
                Reading the Inspect &amp; Cloud report will <strong>replace</strong> what is recorded
                against this {kind}: its photos, its checklist answers, and any room the new report
                does not cover. Recordings are kept, and so is anything filed against them.
              </>
            ) : (
              <>
                This {kind} was closed in Jobber but has no evidence recorded against it. Reading the
                Inspect &amp; Cloud report fills it in
                {inspectionType === 'MOVE_IN'
                  ? ', so a later move-out has a baseline to compare against.'
                  : ', so the walkthrough is on the record here.'}
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <InspectionReportImport
          inspectionType={inspectionType}
          onHandOff={handOff}
          resumeJobId={active.data && !active.data.committedAt ? active.data.id : null}
        />
      </DialogContent>
    </Dialog>
  );
}

/** Working, as opposed to finished, failed, or waiting to be reviewed. */
function isRunning(job: ImportJob | null | undefined) {
  if (!job || job.committedAt || job.errorCode) return false;
  return job.status === 'RUNNING' || job.status === 'PENDING';
}

/**
 * Bringing in an inspection that happened outside this app.
 *
 * Some properties are walked by an agent, or were walked before the handset
 * existed, and the only record is a PDF. Without one a later move-out has
 * nothing to compare against.
 *
 * Two steps, deliberately. The reader will not guess: a label no template
 * carries, a row the inspector typed by hand, a photograph whose caption did
 * not resolve — all of it is shown before anything is written. Going straight
 * from upload to import would make this a formality and put unreviewed
 * evidence behind a charge.
 */
export function InspectionReportImport({
  inspectionType,
  resumeJobId = null,
  onHandOff,
}: {
  /** Wording only. Emptiness and having a property decide importability, not
   * the type. */
  inspectionType?: string | null;
  /** An import already under way here, so reopening picks it up rather than
   * offering to start a second one. */
  resumeJobId?: string | null;
  /** Takes the chosen file. The drawer uploads it and reports progress, so
   * this dialog can close immediately. Absent when rendered outside one. */
  onHandOff?: (file: File) => void;
}) {
  const router = useRouter();
  const { startInspectionImport, commitInspectionImport } = useAdminMutations();
  const [startedJobId, setStartedJobId] = useState<string | null>(null);
  /**
   * What this session started, else whatever the inspection says is running.
   *
   * In that order rather than the reverse: once somebody uploads here, that is
   * the job they are looking at, and it must not be replaced by a slower poll
   * answering about the same one.
   */
  const [dismissed, setDismissed] = useState(false);
  const jobId = dismissed ? null : (startedJobId ?? resumeJobId);
  const [rejected, setRejected] = useState<string | null>(null);
  /** A file is over the drop zone. Purely visual, but without it there is no
   * signal that dropping will do anything. */
  const [dragging, setDragging] = useState(false);
  // Set when the write is asked for. The mutation resolving only means the
  // server accepted the job, so it cannot stand in for "still working".
  const [writing, setWriting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const job = useInspectionImportJob(jobId);

  // The upload lives in the drawer now, so this panel is never in that state.
  const uploading = false;

  /**
   * Only while the file is in the air.
   *
   * The reading itself runs on the server and survives the page, so warning
   * about it would be telling somebody something untrue — and warnings that
   * are not true are how people learn to ignore them. The upload is different:
   * nothing has been stored yet, and closing the tab really does lose it.
   */
  useEffect(() => {
    if (!uploading) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Browsers show their own wording; assigning is what arms the prompt.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [uploading]);

  /**
   * Hands the file to the drawer and gets out of the way.
   *
   * The upload used to run inside this dialog, which is why the dialog could
   * not be closed while it went: closing it took the only progress display with
   * it. The drawer carries it now, so this closes the moment the file is
   * accepted — and everything after, the reading and the writing-in, happens on
   * the server with nothing to watch.
   */
  function upload(file: File) {
    setRejected(null);
    if (file.type !== 'application/pdf') {
      setRejected('That file is not a PDF.');
      return;
    }
    onHandOff?.(file);
  }

  async function commit(mode: 'REPLACE' | 'ADD') {
    if (!jobId) return;
    try {
      setWriting(true);
      // Returns as soon as the write has started. Writing 376 photographs takes
      // longer than the server will hold a socket open, so the job reports the
      // outcome and the poll below follows it.
      await commitInspectionImport.mutateAsync({ jobId, mode });
    } catch {
      setWriting(false);
      // Rendered below from the mutation's own error.
    }
  }

  /**
   * The write finished, so show the filled-in inspection.
   *
   * Driven by the job rather than by the mutation resolving, because the
   * mutation resolves when the work begins.
   */
  const committed = Boolean(job.data?.committedAt);
  const totals = job.data?.summary?.totals;
  /**
   * Announced once, when the write finishes.
   *
   * The dialog can be closed while an import runs, so the person who started it
   * is usually somewhere else by the time it lands — on another property,
   * starting the next one. Without this the only signal is a page they are no
   * longer looking at quietly gaining areas.
   *
   * Guarded by a ref rather than by the effect's dependencies: the job keeps
   * being polled after it commits, and every answer would otherwise announce
   * the same import again.
   */
  const announced = useRef(false);
  useEffect(() => {
    if (!committed) return;
    if (!announced.current) {
      announced.current = true;
      toast.success('Report imported', {
        description: totals
          ? `${totals.areas} areas, ${totals.photos} photographs. It is under review, not finalized.`
          : 'It is under review, not finalized.',
      });
    }
    router.refresh();
  }, [committed, totals, router]);

  /** A failure is worth the same interruption, for the same reason. */
  const failureCode = job.data?.errorCode ?? null;
  const announcedFailure = useRef(false);
  useEffect(() => {
    if (!failureCode || announcedFailure.current) return;
    announcedFailure.current = true;
    toast.error('The report could not be imported', { description: failureCode });
  }, [failureCode]);

  const error =
    rejected ??
    (startInspectionImport.error instanceof Error ? startInspectionImport.error.message : null) ??
    (commitInspectionImport.error instanceof Error ? commitInspectionImport.error.message : null);

  return (
    <div className="space-y-4">
      {error ? (
        <Alert variant="destructive">
          <AlertTriangleIcon />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {!jobId ? (
        <div className="space-y-3">
          <input
            accept="application/pdf"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
              // Cleared so choosing the same file twice still fires a change.
              event.target.value = '';
            }}
            ref={fileInput}
            type="file"
          />
          {/*
            A drop target, and still a button.

            Dropping is the faster path when the report is already sitting in a
            folder, but it is undiscoverable on its own and impossible from a
            keyboard, so the click route stays exactly where it was. The whole
            zone is the button — a small "browse" link inside a large inert
            rectangle invites people to click the rectangle and get nothing.
          */}
          <button
            className={cn(
              'border-border flex w-full flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-8 transition-colors',
              dragging ? 'border-primary bg-primary/5' : 'hover:bg-accent/50',
              uploading && 'pointer-events-none opacity-70',
            )}
            disabled={uploading}
            onClick={() => fileInput.current?.click()}
            onDragLeave={(event) => {
              // Only when the pointer has actually left the zone. Moving over a
              // child fires dragleave for the parent, which would flicker the
              // highlight the entire time somebody hovers over it.
              if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                setDragging(false);
            }}
            onDragOver={(event) => {
              // Both, and every time: without preventDefault the browser
              // navigates to the file instead, which loses the page.
              event.preventDefault();
              setDragging(true);
            }}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              const file = event.dataTransfer.files?.[0];
              if (file) void upload(file);
            }}
            type="button"
          >
            {uploading ? <Spinner /> : <UploadIcon className="text-muted-foreground size-5" />}
            <span className="text-sm font-medium">
              {dragging
                  ? 'Drop the report to start'
                  : 'Drop a report PDF here, or click to choose one'}
            </span>
            {uploading ? (
              <span className="text-muted-foreground text-xs">
                Keep this page open until the upload finishes.
              </span>
            ) : null}
          </button>
          {/* Only while bytes are actually moving. `progress` is null before the
              first event and once the file has landed, and a bar sitting at
              100% while the server reads the file would claim progress that is
              not being made — which is the thing this exists to stop. */}

        </div>
      ) : (
        <ImportProgress
          inspectionType={inspectionType}
          committing={
            // In flight in this tab, or accepted and still being written on the
            // server. The mutation resolving only means the work started.
            commitInspectionImport.isPending ||
            (writing && !job.data?.committedAt && !job.data?.errorCode)
          }
          job={job.data}
          onCommit={(mode) => void commit(mode)}
          onDiscard={() => {
            // Both, because the job may have come from the inspection rather
            // than from this session. Clearing only what this session started
            // would fall straight back to the resumed one and the panel would
            // reappear.
            setStartedJobId(null);
            setDismissed(true);
          }}
        />
      )}
    </div>
  );
}

function ImportProgress({
  inspectionType,
  committing,
  job,
  onCommit,
  onDiscard,
}: {
  committing: boolean;
  inspectionType?: string | null;
  job: ImportJob | undefined;
  onCommit: (mode: 'REPLACE' | 'ADD') => void;
  onDiscard: () => void;
}) {
  // Before the early returns: a hook cannot sit behind one. Defaults to the
  // historical behaviour, so an import nobody thinks about writes as it always did.
  const [mode, setMode] = useState<'REPLACE' | 'ADD'>('REPLACE');

  if (!job)
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-sm">
        <Spinner /> Loading…
      </p>
    );

  if (job.status === 'RUNNING' || job.status === 'PENDING')
    return (
      <div className="space-y-2">
        <p className="flex items-center gap-2 text-sm font-medium">
          <Spinner /> Reading the report…
        </p>
        {/* Said plainly, because the opposite is what people expect of an
            upload. The work is on the server; the page is only watching it. */}
        <p className="text-muted-foreground text-sm">
          This keeps running if you close the page. A long report with hundreds of photographs takes
          a few minutes.
        </p>
      </div>
    );

  if (job.status === 'FAILED')
    return (
      <div className="space-y-3">
        <Alert variant="destructive">
          <AlertTriangleIcon />
          <AlertTitle>The report could not be read</AlertTitle>
          <AlertDescription>{failureReason(job.errorCode)}</AlertDescription>
        </Alert>
        <Button onClick={onDiscard} variant="outline">
          Try another file
        </Button>
      </div>
    );

  const summary = job.summary;
  if (!summary) return null;
  const review = summary.needsReview;
  // Counts entries in the list below, not photographs. Unmatched pictures are
  // one line however many there are, and a heading promising four things above
  // a list of three is the kind of small dishonesty that makes a reader stop
  // trusting the rest of the screen.
  const needsAttention =
    review.lowConfidenceLabels.length +
    review.unrecognisedRows.length +
    (review.photosWithoutSubject > 0 ? 1 : 0);

  return (
    <div className="space-y-4">
      <Alert variant="success">
        <CheckCircle2Icon />
        <AlertTitle>Read {summary.reportDate ? `· ${summary.reportDate}` : null}</AlertTitle>
        <AlertDescription>
          {summary.totals.areas} areas · {summary.totals.items} items · {summary.totals.photos}{' '}
          photographs · {summary.totals.defects} defects
          {summary.inspector ? ` · inspector ${summary.inspector}` : null}
          {/* Which answers were measured and which were inferred. An imported
              inspection is evidence, and where it came from is part of it. */}
          {job.method === 'AI' ? (
            <>
              {' '}
              <Badge variant="secondary">read by AI</Badge>
            </>
          ) : null}
        </AlertDescription>
      </Alert>

      {needsAttention > 0 ? (
        <Alert>
          <AlertTriangleIcon />
          <AlertTitle>{needsAttention} things to check before importing</AlertTitle>
          <AlertDescription>
            <ul className="mt-1 list-disc space-y-1 pl-4">
              {review.lowConfidenceLabels.map((entry) => (
                <li key={`${entry.area}-${entry.sourceLabel}`}>
                  <span className="font-medium">{entry.area}</span>: “{entry.sourceLabel}” read as “
                  {entry.matched ?? 'nothing'}”
                </li>
              ))}
              {review.unrecognisedRows.map((entry) => (
                <li key={`${entry.area}-${entry.text}`}>
                  <span className="font-medium">{entry.area}</span>: “{entry.text}” is not a
                  checklist item — it will not be imported
                </li>
              ))}
              {review.photosWithoutSubject > 0 ? (
                <li>
                  {review.photosWithoutSubject} photographs could not be matched to an item — they
                  are imported against their area
                </li>
              ) : null}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Area</TableHead>
            <TableHead>Items</TableHead>
            <TableHead>Photos</TableHead>
            <TableHead>Defects</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {summary.areas.map((area) => (
            <TableRow key={area.name}>
              <TableCell className="font-medium">{area.name}</TableCell>
              {/* Graded against listed, because a report that covered nine
                  items and graded eight is a different thing from one that
                  graded all nine. */}
              <TableCell className="tabular-nums">
                {area.assessed}/{area.items}
              </TableCell>
              <TableCell className="tabular-nums">{area.photos}</TableCell>
              <TableCell>
                {area.defects.length === 0 ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  <ul className="space-y-0.5">
                    {area.defects.map((defect) => (
                      <li key={defect.item}>
                        <span className="font-medium">{defect.item}</span>
                        {defect.comment ? `: ${defect.comment}` : null}
                      </li>
                    ))}
                  </ul>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {/*
        An agent who submits an incomplete walkthrough issues a second report
        covering what was missed. Importing that the usual way would keep only
        the areas it names and drop the rest, so the choice is made here, with
        the parsed areas visible above, rather than assumed.
      */}
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">How should this be written?</legend>
        <label className="flex items-start gap-2 text-sm">
          <input
            checked={mode === 'REPLACE'}
            className="mt-1"
            name="import-mode"
            onChange={() => setMode('REPLACE')}
            type="radio"
            value="REPLACE"
          />
          <span>
            Replace this inspection
            <span className="text-muted-foreground block text-xs">
              The report becomes the inspection&apos;s evidence. Areas it does not mention are
              removed.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            checked={mode === 'ADD'}
            className="mt-1"
            name="import-mode"
            onChange={() => setMode('ADD')}
            type="radio"
            value="ADD"
          />
          <span>
            Add to this inspection
            <span className="text-muted-foreground block text-xs">
              For a follow-up report covering areas the first one missed. Areas above are written;
              everything else already on the inspection is left alone.
            </span>
          </span>
        </label>
      </fieldset>

      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={committing} onClick={() => onCommit(mode)}>
          {committing ? <Spinner /> : <FileTextIcon />}
          {committing
            ? 'Importing…'
            : mode === 'ADD'
              ? 'Add these areas to the inspection'
              : `Import as ${inspectionType ? `a ${humanize(inspectionType).toLowerCase()}` : 'an'} inspection`}
        </Button>
        <Button disabled={committing} onClick={onDiscard} variant="outline">
          Cancel
        </Button>
        {/* Said before the button rather than after: it lands in review because
            nobody has confirmed these matches yet.

            While it writes, the more useful thing to say is that nobody has to
            wait. The work runs on the server; this only reports it. Not knowing
            that is what had these run one at a time. */}
        <span className="text-muted-foreground text-sm">
          {committing
            ? 'Writing on the server — you can close this and start another.'
            : 'It arrives under review, not finalized.'}
        </span>
      </div>
    </div>
  );
}

function failureReason(code: string | null) {
  if (code === 'REPORT_NOT_RECOGNISED_NO_AI')
    return 'This layout is not one we can read, and no AI provider is configured to fall back on. Add a provider in AI settings, or import this one by hand.';
  if (code === 'IMPORT_ABANDONED')
    return 'The reading stopped before it finished, most likely because the server restarted. Upload the file again.';
  return 'The file could not be read as an inspection report. Check it is the report PDF rather than a scan or a different document.';
}
