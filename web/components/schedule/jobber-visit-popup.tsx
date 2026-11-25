'use client';

import type { JobberDayRow } from '@texasrenters/shared';
import {
  CalendarIcon,
  ChevronRightIcon,
  ClockIcon,
  EllipsisIcon,
  GripIcon,
  MapPinIcon,
  PlusIcon,
  XIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { businessTimeOfDay } from '@/lib/clock';
import { formatScheduledDate } from '@/lib/format';
import { useJobberVisitDetails } from '@/lib/queries';
import { cn } from '@/lib/utils';

import { PersonDisc } from './person-disc';

/** Jobber's own calendar on a day: where anything not done here yet is done (2026-11-25). */
export const jobberDayUrl = (date: string) => `https://secure.getjobber.com/schedule/day/${date.replaceAll('-', '/')}`;

/** Said when a button that would change Jobber is pressed: the app does not change Jobber yet. */
export const NOT_HERE_YET = 'Not in this app yet. Do it in Jobber for now.';

/**
 * Moving the popup by its handle, as Jobber's is moved (2026-11-25). The
 * offset is the popup's own and starts again each time it opens.
 */
export function useDragged() {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const from = useRef<{ x: number; y: number; at: { x: number; y: number } } | null>(null);
  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    from.current = { x: event.clientX, y: event.clientY, at: offset };
    const move = (moved: PointerEvent) => {
      if (!from.current) return;
      setOffset({ x: from.current.at.x + moved.clientX - from.current.x, y: from.current.at.y + moved.clientY - from.current.y });
    };
    const up = () => {
      from.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return { offset, onPointerDown, reset: () => setOffset({ x: 0, y: 0 }) };
}

/**
 * A Jobber visit's popup, laid out as Jobber's (the office, 2026-11-25: "it
 * should be the same size, also the buttons should be the same"): the handle
 * and close, the title, "Visit", Completed, Details, Team with its add and
 * remove, Location, Start, and ··· / Find a time / Edit / Details.
 *
 * Nothing here changes Jobber -- the office's choice while it tests the app
 * (2026-11-25). Completed, add or remove a person, Find a time and Edit say so
 * and point to Jobber's calendar on the day; Details opens the Visit details
 * window, read from Jobber.
 */
export function JobberVisitPopup({
  row,
  date,
  done,
  team,
  time,
  onClose,
  onHandle,
  more,
}: {
  row: JobberDayRow;
  date: string;
  done: boolean;
  team: (string | null)[];
  time: string | null;
  onClose: () => void;
  onHandle: (event: ReactPointerEvent<HTMLElement>) => void;
  /** The app's own ways on from this visit -- the inspection, the comparison -- under ···. */
  more?: ReactNode;
}) {
  const jobber = row.jobber;
  const [notice, setNotice] = useState(false);
  const [details, setDetails] = useState(false);
  const notHere = () => setNotice(true);

  return (
    <div className="text-sm">
      <div className="flex items-center justify-between px-3 pt-2">
        <button
          aria-label="Move"
          className="text-muted-foreground hover:text-heading cursor-grab touch-none rounded p-1 active:cursor-grabbing"
          onPointerDown={onHandle}
          type="button"
        >
          <GripIcon className="size-3.5" />
        </button>
        <button aria-label="Close" className="text-muted-foreground hover:text-heading rounded p-1" onClick={onClose} type="button">
          <XIcon className="size-4" />
        </button>
      </div>
      <div className="space-y-3 px-4 pb-3">
        <div>
          <p className="text-heading leading-snug font-semibold">{jobber?.title ?? row.property}</p>
          <p className="text-muted-foreground text-xs">Visit</p>
        </div>
        <label className="flex w-fit cursor-pointer items-center gap-2">
          <Checkbox checked={done} onCheckedChange={notHere} />
          Completed
        </label>
        {/* Always there, as on Jobber's: the property, then its job. */}
        {jobber ? (
          <section>
            <h3 className="font-semibold">Details</h3>
            <p className="mt-0.5">
              <span className="text-primary underline underline-offset-2">{row.property}</span>
              {jobber.jobNumber ? (
                <>
                  {' - '}
                  <span className="text-primary underline underline-offset-2">Job #{jobber.jobNumber}</span>
                </>
              ) : null}
            </p>
            {/* Cut short as Jobber's is; the whole of it is under Details. */}
            {jobber.details ? <p className="text-muted-foreground mt-1 line-clamp-3 whitespace-pre-line">{jobber.details}</p> : null}
          </section>
        ) : null}
        <section>
          <h3 className="font-semibold">Team</h3>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <button
              aria-label="Add a technician"
              className="text-primary hover:bg-muted inline-flex size-7 items-center justify-center rounded-md border"
              onClick={notHere}
              type="button"
            >
              <PlusIcon className="size-4" />
            </button>
            {team.map((name, index) => (
              <span className="bg-muted flex min-w-0 items-center gap-1.5 rounded-full py-0.5 pr-1 pl-0.5" key={name ?? index}>
                <PersonDisc name={name} />
                <span className="truncate">{name ?? 'Unassigned'}</span>
                {name ? (
                  <button
                    aria-label={`Remove ${name}`}
                    className="text-muted-foreground hover:text-heading rounded-full p-0.5"
                    onClick={notHere}
                    type="button"
                  >
                    <XIcon className="size-3.5" />
                  </button>
                ) : null}
              </span>
            ))}
          </div>
        </section>
        {jobber?.address ? (
          <section>
            <h3 className="font-semibold">Location</h3>
            <p className="mt-0.5">{jobber.address}</p>
          </section>
        ) : null}
        <section>
          <h3 className="font-semibold">Start</h3>
          <p className="mt-0.5">{formatScheduledDate(date)}</p>
          <p>{time ?? 'Anytime'}</p>
        </section>
      </div>
      {notice ? (
        <p className="bg-muted mx-3 mb-2 rounded-md px-3 py-2 text-xs" role="status">
          {NOT_HERE_YET}{' '}
          <a className="text-primary font-medium underline" href={jobberDayUrl(date)} rel="noreferrer" target="_blank">
            Open Jobber’s calendar
          </a>
        </p>
      ) : null}
      <div className="flex items-center gap-2 px-3 pb-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button aria-label="More" className="text-primary px-2" size="sm" variant="ghost">
              <EllipsisIcon className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {more}
            <DropdownMenuItem asChild>
              <a href={jobberDayUrl(date)} rel="noreferrer" target="_blank">
                Open in Jobber
              </a>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button className="flex-1" onClick={notHere} size="sm" variant="outline">
          <ClockIcon className="size-4" />
          Find a time
        </Button>
        <Button onClick={notHere} size="sm" variant="outline">
          Edit
        </Button>
        <Button disabled={!row.jobberVisitId} onClick={() => setDetails(true)} size="sm">
          Details
        </Button>
      </div>
      {row.jobberVisitId ? (
        <VisitDetailsDialog date={date} jobberVisitId={row.jobberVisitId} onOpenChange={setDetails} open={details} row={row} />
      ) : null}
    </div>
  );
}

/**
 * Jobber's "Visit details" window (2026-11-25): the title and address, the day
 * and Directions, Mark Complete and More Actions, then Info, Client, Notes and
 * Checklists -- read from Jobber when it opens, all of it read-only here.
 */
export function VisitDetailsDialog({
  jobberVisitId,
  row,
  date,
  open,
  onOpenChange,
}: {
  jobberVisitId: string;
  row: JobberDayRow;
  date: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const query = useJobberVisitDetails(jobberVisitId, open);
  const visit = query.data;
  const [notice, setNotice] = useState(false);
  const title = visit?.title ?? row.jobber?.title ?? row.property;
  const address = visit?.addressLines ?? (row.jobber?.address ? [row.jobber.address] : []);
  const time = visit?.startAt ? businessTimeOfDay(visit.startAt) : null;
  const directions = address.length
    ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address.join(', '))}`
    : null;
  const team = visit?.team ?? (row.jobber?.technician ? row.jobber.technician.split(', ') : []);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[90vh] w-[40rem] max-w-[calc(100vw-2rem)] overflow-y-auto p-0 sm:max-w-[40rem]">
        <div className="border-b px-5 py-4">
          <DialogTitle className="text-heading text-xl">Visit details</DialogTitle>
        </div>
        <div className="space-y-4 px-5 py-4 text-sm">
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_12rem]">
            <div>
              <p className="text-heading text-base leading-snug font-semibold">{title}</p>
              <div className="mt-2">
                {address.map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <p className="flex items-center gap-2 font-semibold">
                <CalendarIcon className="size-4" />
                {formatScheduledDate(visit?.date ?? date)} {time ?? 'Anytime'}
              </p>
              {directions ? (
                <a className="flex items-center gap-2 font-semibold" href={directions} rel="noreferrer" target="_blank">
                  <MapPinIcon className="text-primary size-4" />
                  Directions
                </a>
              ) : null}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Button disabled={visit?.completed} onClick={() => setNotice(true)}>
              {visit?.completed ? 'Completed' : 'Mark Complete'}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button className="text-primary" variant="outline">
                  <EllipsisIcon className="size-4" />
                  More Actions
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {visit?.job?.url ? (
                  <DropdownMenuItem asChild>
                    <a href={visit.job.url} rel="noreferrer" target="_blank">
                      Open the job in Jobber
                    </a>
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem asChild>
                  <a href={jobberDayUrl(visit?.date ?? date)} rel="noreferrer" target="_blank">
                    Open Jobber’s calendar
                  </a>
                </DropdownMenuItem>
                {row.inspectionId ? (
                  <DropdownMenuItem asChild>
                    <Link href={`/inspections/${row.inspectionId}`}>Open inspection</Link>
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {notice ? (
            <p className="bg-muted rounded-md px-3 py-2 text-xs" role="status">
              {NOT_HERE_YET}{' '}
              <a className="text-primary font-medium underline" href={jobberDayUrl(visit?.date ?? date)} rel="noreferrer" target="_blank">
                Open Jobber’s calendar
              </a>
            </p>
          ) : null}
          {query.isError ? (
            <p className="text-destructive text-sm" role="alert">
              {query.error instanceof Error ? query.error.message : 'Jobber’s details could not be read.'}
            </p>
          ) : null}
          <Tabs defaultValue="info">
            <TabsList>
              <TabsTrigger value="info">Info</TabsTrigger>
              <TabsTrigger value="client">Client</TabsTrigger>
              <TabsTrigger value="notes">
                Notes <Count value={visit?.notesTotal} />
              </TabsTrigger>
              <TabsTrigger value="checklists">
                Checklists <Count value={visit?.checklistsToDo} />
              </TabsTrigger>
            </TabsList>
            <TabsContent className="space-y-4 pt-3" value="info">
              <section>
                <h3 className="font-semibold">Instructions</h3>
                {query.isPending ? (
                  <Skeleton className="mt-2 h-24 w-full" />
                ) : (
                  <p className="mt-1 max-h-56 overflow-y-auto pr-2 whitespace-pre-line">
                    {visit?.instructions ?? row.jobber?.details ?? 'No instructions'}
                  </p>
                )}
              </section>
              <div className="grid gap-4 border-t pt-3 sm:grid-cols-3">
                <section>
                  <h3 className="font-semibold">Job</h3>
                  {visit?.job ?? row.jobber?.jobNumber ? (
                    <div className="mt-1">
                      {visit?.job?.url ? (
                        <a className="text-primary flex items-center justify-between underline underline-offset-2" href={visit.job.url} rel="noreferrer" target="_blank">
                          Job # {visit.job.number}
                          <ChevronRightIcon className="size-4" />
                        </a>
                      ) : (
                        <p>Job # {visit?.job?.number ?? row.jobber?.jobNumber}</p>
                      )}
                      <p className="text-muted-foreground mt-0.5">{title}</p>
                    </div>
                  ) : (
                    <p className="text-muted-foreground mt-1">No job</p>
                  )}
                </section>
                <section>
                  <h3 className="font-semibold">Team</h3>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {team.length ? (
                      team.map((name) => (
                        <span className="bg-muted rounded-full px-2 py-0.5 text-xs font-medium" key={name}>
                          {name}
                        </span>
                      ))
                    ) : (
                      <span className="text-muted-foreground">Nobody yet</span>
                    )}
                  </div>
                </section>
                <section>
                  <h3 className="font-semibold">Reminders</h3>
                  <p className="text-muted-foreground mt-1 italic">Set in Jobber</p>
                </section>
              </div>
              <section className="border-t pt-3">
                {visit?.lineItems?.length ? (
                  <ul className="space-y-1">
                    {visit.lineItems.map((item, index) => (
                      <li className="flex justify-between gap-3" key={`${item.name}-${index}`}>
                        <span>
                          {item.name}
                          {item.quantity !== null ? <span className="text-muted-foreground"> × {item.quantity}</span> : null}
                        </span>
                        {item.totalPrice !== null ? <span>${item.totalPrice.toFixed(2)}</span> : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-muted-foreground italic">
                    {visit && visit.lineItems === null ? 'Line items could not be read from Jobber' : 'No line items'}
                  </p>
                )}
              </section>
            </TabsContent>
            <TabsContent className="space-y-2 pt-3" value="client">
              {visit?.client ? (
                <>
                  <p className="text-heading font-semibold">{visit.client.name}</p>
                  {visit.client.phones.map((phone) => (
                    <p key={phone}>
                      <a className="underline" href={`tel:${phone}`}>
                        {phone}
                      </a>
                    </p>
                  ))}
                  {visit.client.emails.map((email) => (
                    <p key={email}>
                      <a className="underline" href={`mailto:${email}`}>
                        {email}
                      </a>
                    </p>
                  ))}
                  {visit.client.url ? (
                    <a className="text-primary underline" href={visit.client.url} rel="noreferrer" target="_blank">
                      Open the client in Jobber
                    </a>
                  ) : null}
                </>
              ) : (
                <p className="text-muted-foreground">{query.isPending ? 'Reading Jobber…' : 'No client'}</p>
              )}
            </TabsContent>
            <TabsContent className="space-y-3 pt-3" value="notes">
              {visit?.notes.length ? (
                visit.notes.map((note, index) => (
                  <div className="rounded-md border px-3 py-2" key={index}>
                    <p className="whitespace-pre-line">{note.message}</p>
                    {note.createdAt ? (
                      <p className="text-muted-foreground mt-1 text-xs">{formatScheduledDate(note.createdAt.slice(0, 10))}</p>
                    ) : null}
                  </div>
                ))
              ) : (
                <p className="text-muted-foreground">{query.isPending ? 'Reading Jobber…' : 'No notes'}</p>
              )}
              {visit && visit.notesTotal > visit.notes.length ? (
                <p className="text-muted-foreground text-xs">
                  {visit.notesTotal - visit.notes.length} more in Jobber
                </p>
              ) : null}
            </TabsContent>
            <TabsContent className="pt-3" value="checklists">
              <p className="text-muted-foreground">
                {visit?.checklistsToDo
                  ? `${visit.checklistsToDo} ${visit.checklistsToDo === 1 ? 'checklist' : 'checklists'} to fill in, in Jobber`
                  : query.isPending
                    ? 'Reading Jobber…'
                    : 'No checklists to fill in'}
              </p>
            </TabsContent>
          </Tabs>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Count({ value }: { value: number | null | undefined }) {
  if (!value) return null;
  return <span className={cn('bg-muted ml-1 rounded-full px-1.5 text-[11px] font-semibold')}>{value}</span>;
}
