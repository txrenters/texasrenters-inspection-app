'use client';

import {
  JOB_INSPECTION_LABEL,
  JOB_INSPECTION_TYPES,
  isJobInspectionType,
  type AdminJob,
  type AdminJobInspection,
  type JobInspectionType,
} from '@texasrenters/shared';
import { BriefcaseIcon, PlusIcon } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';

import { CheckRow } from '@/components/booking-form-controls';
import { PageHeader } from '@/components/page-header';
import { SECTION_LABEL } from '@/components/panel';
import { ErrorState, PageSkeleton } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { usePermissions } from '@/lib/auth';
import { formatDay, formatDateTime } from '@/lib/format';
import { typeTitle } from '@/lib/inspection-type-tone';
import { useJob, useJobWork } from '@/lib/queries';

const OUTCOME: Record<AdminJob['services'][number]['outcome'], { label: string; variant: 'success' | 'warning' | 'secondary' }> = {
  DONE: { label: 'Done', variant: 'success' },
  NOT_DONE: { label: 'Not done', variant: 'warning' },
  TODO: { label: 'To do', variant: 'secondary' },
};

const kindName = (type: string) => (isJobInspectionType(type) ? JOB_INSPECTION_LABEL[type] : typeTitle(type));

/**
 * One job (2026-11-20, phase 5 of the jobs plan): what it is, each inspection
 * in it with where it stands, the services on its lead with what the
 * technician answered, and the two changes a job takes -- more work on the
 * same visit, and work nobody has started taken off. Everything else about an
 * inspection is on the inspection's own page, one click from its row.
 */
export default function JobPage() {
  const id = useParams<{ jobId: string }>().jobId;
  const job = useJob(id);
  const { has } = usePermissions();
  const canManage = has('inspections:manage');
  const [adding, setAdding] = useState(false);
  const [takingOff, setTakingOff] = useState<AdminJobInspection | null>(null);

  if (job.isLoading) return <PageSkeleton cards={2} />;
  if (job.isError || !job.data) return <ErrorState error={job.error} retry={() => void job.refetch()} />;
  const item = job.data;
  const lead = item.inspections.find((inspection) => inspection.lead);
  const where = [item.property.addressLine1 ?? item.property.name, item.unit?.name ? `Unit ${item.unit.name}` : null]
    .filter(Boolean)
    .join(', ');

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          canManage && item.canAddWork ? (
            <Button onClick={() => setAdding(true)} type="button">
              <PlusIcon />
              Add work
            </Button>
          ) : undefined
        }
        badges={<StatusBadge value={item.state} />}
        description={
          <span className="flex flex-wrap gap-x-1.5">
            <span className="text-foreground font-mono font-semibold">{item.number}</span>
            <span aria-hidden>·</span>
            <span>{where}</span>
            {item.scheduledAt ? (
              <>
                <span aria-hidden>·</span>
                <span>{formatDay(item.scheduledAt, 'long')}</span>
              </>
            ) : null}
            <span aria-hidden>·</span>
            <span>{item.technician?.displayName ?? 'Nobody assigned'}</span>
          </span>
        }
        prominent
        record={{ icon: BriefcaseIcon, tone: 'text-primary', label: 'Job' }}
        title={item.title}
      />

      <Card>
        <CardHeader>
          <CardTitle variant="label">The work in this job</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            {/* Not sticky: a card is not the page, and its header pinned 48px down over the first row. */}
            <TableHeader className="lg:static">
              <TableRow>
                <TableHead>Work</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Technician</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {item.inspections.map((inspection) => (
                <TableRow key={inspection.id}>
                  <TableCell>
                    <span className="font-medium">{kindName(inspection.inspectionType)} inspection</span>
                    {inspection.lead ? (
                      <span className="text-muted-foreground block text-xs">Leads the job: the services and the Jobber visit are on it</span>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <StatusBadge value={inspection.state} />
                  </TableCell>
                  <TableCell>{inspection.technician?.displayName ?? 'Nobody'}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap justify-end gap-2">
                      {canManage && inspection.canTakeOff ? (
                        <Button onClick={() => setTakingOff(inspection)} size="sm" type="button" variant="ghost">
                          Take off
                        </Button>
                      ) : null}
                      <Button asChild size="sm" variant="outline">
                        <Link href={`/inspections/${inspection.id}`}>Open inspection</Link>
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="text-muted-foreground mt-3 text-xs">
            Work comes off only while nobody has started it. Once started it stays on the job, and the phone marks it Not
            done.
          </p>
        </CardContent>
      </Card>

      {item.services.length && lead ? (
        <Card>
          <CardHeader>
            <CardTitle variant="label">Services on the {kindName(lead.inspectionType)} inspection</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              {item.services.map((service) => (
                <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5" key={service.key}>
                  <span className="min-w-40 font-medium">{service.label}</span>
                  <Badge variant={OUTCOME[service.outcome].variant}>{OUTCOME[service.outcome].label}</Badge>
                  {service.reason ? <span className="text-muted-foreground text-sm">{service.reason}</span> : null}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <p className={SECTION_LABEL}>Made {formatDateTime(item.createdAt)}</p>

      {adding ? <AddWorkDialog job={item} onClose={() => setAdding(false)} /> : null}
      {takingOff ? <TakeOffDialog inspection={takingOff} job={item} onClose={() => setTakingOff(null)} /> : null}
    </div>
  );
}

/** More inspections on the job's day, for its technician: the kinds it does not have yet. */
function AddWorkDialog({ job, onClose }: { job: AdminJob; onClose: () => void }) {
  const work = useJobWork(job.id);
  const live = new Set(
    job.inspections.filter((inspection) => inspection.state !== 'CANCELLED').map((inspection) => inspection.inspectionType),
  );
  const offered = JOB_INSPECTION_TYPES.filter((type) => !live.has(type));
  const [picked, setPicked] = useState<ReadonlySet<JobInspectionType>>(new Set());
  const toggle = (type: JobInspectionType) => (checked: boolean) =>
    setPicked((current) => {
      const next = new Set(current);
      if (checked) next.add(type);
      else next.delete(type);
      return next;
    });
  const save = () =>
    work.add.mutate(
      { inspectionTypes: JOB_INSPECTION_TYPES.filter((type) => picked.has(type)) },
      { onSuccess: onClose },
    );

  return (
    <Dialog onOpenChange={(open) => (open ? undefined : onClose())} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add work to {job.number}</DialogTitle>
          <DialogDescription>
            On the same day, for {job.technician?.displayName ?? 'nobody yet'}. Each is its own inspection, with its own
            report.
          </DialogDescription>
        </DialogHeader>
        {offered.length ? (
          <div className="grid gap-x-6 sm:grid-cols-2">
            {offered.map((type) => (
              <CheckRow checked={picked.has(type)} key={type} label={JOB_INSPECTION_LABEL[type]} onChange={toggle(type)} />
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">This job has every kind of inspection already.</p>
        )}
        {work.add.error ? (
          <Alert variant="destructive">
            <AlertDescription>{work.add.error.message}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button onClick={onClose} type="button" variant="outline">
            Cancel
          </Button>
          <Button disabled={!picked.size || work.add.isPending} onClick={save} type="button">
            {work.add.isPending ? <Spinner /> : null}
            Add {picked.size > 1 ? `${picked.size} inspections` : 'to the job'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Takes an inspection nobody has started off the job: cancelled, with the job named as the reason. */
function TakeOffDialog({ job, inspection, onClose }: { job: AdminJob; inspection: AdminJobInspection; onClose: () => void }) {
  const work = useJobWork(job.id);
  const name = `${kindName(inspection.inspectionType)} inspection`;
  return (
    <AlertDialog onOpenChange={(open) => (open ? undefined : onClose())} open>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Take the {name} off {job.number}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            It is cancelled, with &ldquo;Taken off job {job.number}&rdquo; as the reason, and leaves{' '}
            {inspection.technician ? `${inspection.technician.displayName}'s` : 'the'} list. The rest of the job stays as it is.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {work.takeOff.error ? (
          <Alert variant="destructive">
            <AlertDescription>{work.takeOff.error.message}</AlertDescription>
          </Alert>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <Button
            disabled={work.takeOff.isPending}
            onClick={() => work.takeOff.mutate(inspection.id, { onSuccess: onClose })}
            type="button"
            variant="destructive"
          >
            {work.takeOff.isPending ? <Spinner /> : null}
            Take it off
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
