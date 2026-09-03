'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangleIcon, CheckCircle2Icon, FileTextIcon, UploadIcon } from 'lucide-react';

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
import { useAdminMutations, useInspectionImportJob, type ImportJob } from '@/lib/queries';

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
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <UploadIcon />
          Import a report
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
        <InspectionReportImport inspectionId={inspectionId} />
      </DialogContent>
    </Dialog>
  );
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
export function InspectionReportImport({ inspectionId }: { inspectionId: string }) {
  const router = useRouter();
  const { startInspectionImport, commitInspectionImport } = useAdminMutations();
  const [jobId, setJobId] = useState<string | null>(null);
  const [rejected, setRejected] = useState<string | null>(null);
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
      const started = await startInspectionImport.mutateAsync({ inspectionId, file });
      setJobId(started.jobId);
    } catch {
      // Rendered below from the mutation's own error.
    }
  }

  async function commit() {
    if (!jobId) return;
    try {
      const result = await commitInspectionImport.mutateAsync(jobId);
      router.push(`/inspections/${result.inspectionId}`);
    } catch {
      // Rendered below from the mutation's own error.
    }
  }

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
              {uploading ? 'Uploading…' : 'Choose a report PDF'}
            </Button>
            {uploading ? (
              <span className="text-muted-foreground text-sm">
                Keep this page open until the upload finishes.
              </span>
            ) : null}
          </div>
        </div>
      ) : (
        <ImportProgress
          committing={commitInspectionImport.isPending}
          job={job.data}
          onCommit={() => void commit()}
          onDiscard={() => setJobId(null)}
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
            nobody has confirmed these matches yet. */}
        <span className="text-muted-foreground text-sm">
          It arrives under review, not finalized.
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
