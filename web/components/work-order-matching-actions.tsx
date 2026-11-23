'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  OpenWorkOrderCheckResult,
  ScopeSheetImportResult,
  WorkOrderMatchingStatus,
} from '@texasrenters/shared';
import { ListChecksIcon, SheetIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { WorkOrderCrewButton } from '@/components/work-order-crew-dialog';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/auth';
import { humanize } from '@/lib/format';

const BASE = '/api/v1/admin/work-order-matching';

/**
 * Skill matching, from the Work orders page: whether it assigns or is still a
 * trial, loading the office's Technicians' Scope of Work sheet, and matching
 * the work orders already waiting. Only for those who decide who is qualified
 * for what (`technicians:skills`).
 */
export function WorkOrderMatchingActions() {
  const { has } = usePermissions();
  const allowed = has('technicians:skills');
  const client = useQueryClient();
  const [preview, setPreview] = useState<ScopeSheetImportResult | null>(null);

  const status = useQuery({
    queryKey: ['admin', 'work-order-matching'],
    queryFn: ({ signal }) => api<WorkOrderMatchingStatus>(BASE, { signal }),
    enabled: allowed,
  });

  const importSheet = useMutation({
    mutationFn: (apply: boolean) =>
      api<ScopeSheetImportResult>(`${BASE}/import-skills`, {
        method: 'POST',
        body: JSON.stringify({ apply }),
      }),
    onSuccess: (result) => {
      if (!result.applied) return setPreview(result);
      setPreview(null);
      toast.success(
        `Skills loaded for ${result.found.join(', ')}${result.missing.length ? `. Left out: ${result.missing.join(', ')}` : ''}.`,
      );
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'The sheet could not be loaded.'),
  });

  const checkOpen = useMutation({
    mutationFn: () => api<OpenWorkOrderCheckResult>(`${BASE}/check-open`, { method: 'POST' }),
    onSuccess: (result) => {
      const parts = Object.entries(result.outcomes).map(([outcome, count]) => `${count} ${humanize(outcome).toLowerCase()}`);
      toast.success(
        result.checked
          ? `Checked ${result.checked} waiting work order${result.checked === 1 ? '' : 's'}: ${parts.join(', ') || 'nothing to match'}.`
          : 'No work orders are waiting for a technician.',
      );
      void client.invalidateQueries({ queryKey: ['admin', 'inspection'] });
      void client.invalidateQueries({ queryKey: ['admin', 'inspections'] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'The check did not finish.'),
  });

  if (!allowed) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {status.data ? (
        <Badge variant={status.data.live ? 'success' : 'outline'}>
          {status.data.live ? 'Auto-assign on' : 'Auto-assign trial: suggests only'}
        </Badge>
      ) : null}
      <WorkOrderCrewButton />
      <Button disabled={importSheet.isPending} onClick={() => importSheet.mutate(false)} size="sm" variant="outline">
        <SheetIcon />
        Load skills sheet
      </Button>
      <Button disabled={checkOpen.isPending} onClick={() => checkOpen.mutate()} size="sm" variant="outline">
        <ListChecksIcon />
        {checkOpen.isPending ? 'Checking…' : 'Check open work orders'}
      </Button>

      <AlertDialog onOpenChange={(open) => (open ? undefined : setPreview(null))} open={preview !== null}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Load the Technicians&apos; Scope of Work sheet?</AlertDialogTitle>
            <AlertDialogDescription>
              {preview?.skills} job types and {preview?.marks} Y marks. Loading again replaces each person&apos;s marks
              with the sheet&apos;s.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {preview ? (
            <div className="grid gap-2 text-sm">
              <p>
                <span className="text-muted-foreground">Found: </span>
                {preview.found.join(', ') || 'nobody'}
              </p>
              {preview.missing.length ? (
                <p className="text-warning">
                  Not found as active technicians, left out: {preview.missing.join(', ')}. Their names must match the
                  Technicians page exactly.
                </p>
              ) : null}
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              disabled={!preview?.found.length || importSheet.isPending}
              onClick={() => importSheet.mutate(true)}
            >
              Load for {preview?.found.length ?? 0} technician{preview?.found.length === 1 ? '' : 's'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
