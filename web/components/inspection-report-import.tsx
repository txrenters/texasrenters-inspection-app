'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
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
import { Progress } from '@/components/ui/progress';
import { Spinner } from '@/components/ui/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  useActiveInspectionImport,
  useAdminMutations,
  useInspectionImportJob,
  type ImportJob,
} from '@/lib/queries';

/**
 * The way in, from the inspection that needs filling.
 *
 * Shown on a move-in that Jobber closed but nothing was ever recorded
 * against -- the walk happened in another system, so the record arrives here
 * complete and empty. The import is what puts its evidence back.
 *
 * A dialog rather than a panel: this is done once per inspection, and a
 * permanent block on a page people read repeatedly costs more attention than
 * it earns.
 */
export function ImportReportDialog({ inspectionId }: { inspectionId: string }) {
  const [open, setOpen] = useState(false);
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

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger asChild>
        <Button variant="outline">
          {running ? <Spinner /> : <UploadIcon />}
          {running ? 'Import in progress' : 'Import a report'}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Import an inspection report</DialogTitle>
          <DialogDescription>
            This move-in was closed in Jobber but has no evidence recorded against it. Reading the
            Inspect &amp; Cloud report fills it in, so a later move-out has a baseline to compare
            against.
          </DialogDescription>
        </DialogHeader>
        <InspectionReportImport
          inspectionId={inspectionId}
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
  inspectionId,
  resumeJobId = null,
}: {
  inspectionId: string;
  /** An import already under way here, so reopening picks it up rather than
   * offering to start a second one. */
  resumeJobId?: string | null;
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
  /**
   * How much of the file has reached the server, 0 to 1.
   *
   * Null until the first progress event, and null again once the upload is
   * done. A report is tens of megabytes — one recent upload took 165 seconds,
   * during which the server ran no queries at all because it was purely
   * receiving bytes — and a spinner that never moves for that long is
   * indistinguishable from a hang. It was reported as one.
   */
  const [progress, setProgress] = useState<number | null>(null);
  // Set when the write is asked for. The mutation resolving only means the
  // server accepted the job, so it cannot stand in for "still working".
  const [writing, setWriting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const job = useInspectionImportJob(jobId);

  const uploading = startInspectionImport.isPending;

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

  async function upload(file: File) {
    setRejected(null);
    if (file.type !== 'application/pdf') {
      setRejected('That file is not a PDF.');
      return;
    }
    try {
      setProgress(0);
      const started = await startInspectionImport.mutateAsync({
        inspectionId,
        file,
        onProgress: setProgress,
      });
      setDismissed(false);
      setStartedJobId(started.jobId);
    } catch {
      // Rendered below from the mutation's own error.
    } finally {
      // Cleared either way: the upload is over, and leaving a bar at 100% while
      // the server reads the file would claim progress that is not being made.
      setProgress(null);
    }
  }

  async function commit() {
    if (!jobId) return;
    try {
      setWriting(true);
      // Returns as soon as the write has started. Writing 376 photographs takes
      // longer than the server will hold a socket open, so the job reports the
      // outcome and the poll below follows it.
      await commitInspectionImport.mutateAsync(jobId);
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
          <div className="flex flex-wrap items-center gap-3">
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
            <Button disabled={uploading} onClick={() => fileInput.current?.click()}>
              {uploading ? <Spinner /> : <UploadIcon />}
              {uploading
                ? progress === null
                  ? 'Uploading…'
                  : `Uploading… ${Math.round(progress * 100)}%`
                : 'Choose a report PDF'}
            </Button>
            {uploading ? (
              <span className="text-muted-foreground text-sm">
                Keep this page open until the upload finishes.
              </span>
            ) : null}
          </div>
          {/* Only while bytes are actually moving. `progress` is null before the
              first event and once the file has landed, and a bar sitting at
              100% while the server reads the file would claim progress that is
              not being made — which is the thing this exists to stop. */}
          {uploading && progress !== null ? (
            <Progress className="h-1.5" value={Math.round(progress * 100)} />
          ) : null}
        </div>
      ) : (
        <ImportProgress
          committing={
            // In flight in this tab, or accepted and still being written on the
            // server. The mutation resolving only means the work started.
            commitInspectionImport.isPending ||
            (writing && !job.data?.committedAt && !job.data?.errorCode)
          }
          job={job.data}
          onCommit={() => void commit()}
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
  committing,
  job,
  onCommit,
  onDiscard,
}: {
  committing: boolean;
  job: ImportJob | undefined;
  onCommit: () => void;
  onDiscard: () => void;
}) {
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

      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={committing} onClick={onCommit}>
          {committing ? <Spinner /> : <FileTextIcon />}
          {committing ? 'Importing…' : 'Import as a move-in inspection'}
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
