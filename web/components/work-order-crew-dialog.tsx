'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkOrderCrewEntry } from '@texasrenters/shared';
import { UsersRoundIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';

const CREW = '/api/v1/admin/work-order-matching/crew';
const CREW_KEY = ['admin', 'work-order-matching', 'crew'] as const;

/**
 * Which technicians the work-order matcher may pick (the office, 2026-11-24:
 * "add technician ... and we can remove, we will still use the technician
 * skills"). Ticking nobody goes back to everyone. Saved as a whole list, so
 * the press is the decision and nothing changes while boxes are being ticked.
 */
export function WorkOrderCrewButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)} size="sm" variant="outline">
        <UsersRoundIcon />
        Matching crew
      </Button>
      {open ? <WorkOrderCrewDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function WorkOrderCrewDialog({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const crew = useQuery({
    queryKey: CREW_KEY,
    queryFn: ({ signal }) => api<WorkOrderCrewEntry[]>(CREW, { signal }),
  });
  // Null until the person ticks something: until then the list shows what is saved.
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const rows = crew.data ?? [];
  const chosen = picked ?? new Set(rows.filter((row) => row.inCrew).map((row) => row.technicianId));

  const save = useMutation({
    mutationFn: (technicianIds: string[]) =>
      api<WorkOrderCrewEntry[]>(CREW, { method: 'PUT', body: JSON.stringify({ technicianIds }) }),
    onSuccess: (saved) => {
      client.setQueryData(CREW_KEY, saved);
      toast.success('Matching crew saved. Press "Check open work orders" to match the waiting ones again.');
      onClose();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'The crew could not be saved.'),
  });

  const toggle = (id: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(id);
    else next.delete(id);
    setPicked(next);
  };
  // Everyone ticked is the same as nobody chosen: every technician is considered.
  const everyone = rows.length > 0 && rows.every((row) => chosen.has(row.technicianId));

  return (
    <Dialog onOpenChange={(open) => (open ? undefined : onClose())} open>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Matching crew</DialogTitle>
          <DialogDescription>
            The technicians work orders may be matched to. Their skills still decide who fits each job.
          </DialogDescription>
        </DialogHeader>

        {crew.isLoading ? (
          <div aria-busy="true" className="grid gap-2">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">No active technicians. Add them on the Technicians page.</p>
        ) : (
          <ul className="grid max-h-80 gap-1 overflow-y-auto">
            {rows.map((row) => (
              <li key={row.technicianId}>
                <label className="hover:bg-muted/50 flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-sm">
                  <Checkbox
                    checked={chosen.has(row.technicianId)}
                    onCheckedChange={(value) => toggle(row.technicianId, value === true)}
                  />
                  <span className="flex-1 font-medium">{row.displayName}</span>
                  <span className={row.skills ? 'text-muted-foreground text-xs' : 'text-warning text-xs'}>
                    {row.skills ? `${row.skills} skills` : 'no skills yet'}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}

        <DialogFooter className="items-center sm:justify-between">
          <span className="text-muted-foreground text-xs">
            {chosen.size === 0 || everyone ? 'Everyone is considered' : `${chosen.size} of ${rows.length} considered`}
          </span>
          <div className="flex gap-2">
            <Button onClick={onClose} variant="outline">
              Cancel
            </Button>
            <Button
              disabled={save.isPending || crew.isLoading || picked === null}
              onClick={() => save.mutate(everyone ? [] : [...chosen])}
            >
              Save
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
