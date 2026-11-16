'use client';

import { useState } from 'react';
import { toast } from 'sonner';

import { ErrorState, PageSkeleton } from '@/components/states';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useExcelSync, useExcelSyncEdits } from '@/lib/actual-vs-budget-queries';
import { formatRelative } from '@/lib/format';

/**
 * The office's own workbook in Excel (2026-11-17): the Microsoft account that
 * writes it, its link, the first day the console writes, and the switch.
 */
export function ExcelSyncDialog({ canManage, onClose }: { canManage: boolean; onClose: () => void }) {
  const excel = useExcelSync(true);
  const edits = useExcelSyncEdits();
  const [link, setLink] = useState<string | null>(null);

  // Sign-in happens at Microsoft, in a tab of its own opened from the click, as Xero's.
  const connect = async () => {
    try {
      const { authorizationUrl } = await edits.connect.mutateAsync();
      window.open(authorizationUrl, '_blank', 'noopener,noreferrer');
    } catch (error) {
      toast.error('Microsoft could not be opened', { description: error instanceof Error ? error.message : undefined });
    }
  };
  const save = (input: Parameters<typeof edits.save.mutate>[0], done?: () => void) =>
    edits.save.mutate(input, {
      onSuccess: done,
      onError: (error) => toast.error('Not saved', { description: error.message }),
    });
  const syncNow = () =>
    edits.sync.mutate(undefined, {
      onSuccess: (run) => {
        const rows = run.tabs.reduce((sum, tab) => sum + tab.rowsWritten, 0);
        toast.success(rows ? `Wrote ${rows} rows` : 'The workbook is up to date');
      },
      onError: (error) => toast.error('Not written', { description: error.message }),
    });

  return (
    <Dialog onOpenChange={(open) => (open ? null : onClose())} open>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Excel</DialogTitle>
        </DialogHeader>
        {excel.isPending ? (
          <PageSkeleton cards={0} />
        ) : excel.isError ? (
          <ErrorState error={excel.error} retry={() => void excel.refetch()} />
        ) : !excel.data.configured ? (
          <p className="text-muted-foreground text-sm">The server has no Microsoft app settings yet.</p>
        ) : (
          <div className="grid gap-4 text-sm">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="font-medium">Microsoft account</div>
                <div className="text-muted-foreground truncate">
                  {excel.data.connection?.status === 'CONNECTED'
                    ? (excel.data.connection.accountEmail ?? excel.data.connection.accountName ?? 'Connected')
                    : excel.data.connection?.status === 'REAUTHORIZATION_REQUIRED'
                      ? 'Sign in again'
                      : 'Not connected'}
                </div>
                {excel.data.connection?.problem ? <div className="text-destructive">{excel.data.connection.problem}</div> : null}
              </div>
              {canManage ? (
                <div className="flex shrink-0 gap-2">
                  {excel.data.connection?.status === 'CONNECTED' ? (
                    <Button disabled={edits.disconnect.isPending} onClick={() => edits.disconnect.mutate(undefined, { onError: (error) => toast.error('Not disconnected', { description: error.message }) })} size="sm" variant="outline">
                      Disconnect
                    </Button>
                  ) : null}
                  <Button disabled={edits.connect.isPending} onClick={() => void connect()} size="sm" variant={excel.data.connection?.status === 'CONNECTED' ? 'ghost' : 'default'}>
                    {excel.data.connection?.status === 'CONNECTED' ? 'Change' : 'Connect'}
                  </Button>
                </div>
              ) : null}
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="excel-link">Workbook link</Label>
              <div className="flex gap-2">
                <Input
                  disabled={!canManage || excel.data.connection?.status !== 'CONNECTED'}
                  id="excel-link"
                  onChange={(event) => setLink(event.target.value)}
                  placeholder="https://…sharepoint.com/…"
                  value={link ?? excel.data.workbook?.shareUrl ?? ''}
                />
                {canManage && link !== null && link.trim() !== (excel.data.workbook?.shareUrl ?? '') ? (
                  <Button disabled={edits.save.isPending || !link.trim()} onClick={() => save({ shareUrl: link.trim() }, () => setLink(null))} size="sm">
                    {edits.save.isPending ? 'Opening…' : 'Save'}
                  </Button>
                ) : null}
              </div>
              {excel.data.workbook ? (
                <a className="text-muted-foreground truncate underline-offset-2 hover:underline" href={excel.data.workbook.webUrl ?? excel.data.workbook.shareUrl} rel="noreferrer" target="_blank">
                  {excel.data.workbook.fileName}
                </a>
              ) : null}
            </div>

            {excel.data.workbook ? (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor="excel-start">Writes from</Label>
                    <DatePicker disabled={!canManage} id="excel-start" onChange={(startDate) => save({ startDate })} value={excel.data.workbook.startDate} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="excel-on">On</Label>
                    <Switch
                      checked={excel.data.workbook.enabled}
                      disabled={!canManage || edits.save.isPending}
                      id="excel-on"
                      onCheckedChange={(enabled) => save({ enabled })}
                    />
                  </div>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    {excel.data.workbook.problem ? (
                      <span className="text-destructive">{excel.data.workbook.problem}</span>
                    ) : excel.data.workbook.waiting && excel.data.workbook.enabled ? (
                      <span className="text-muted-foreground">Writing within a minute</span>
                    ) : excel.data.workbook.lastPushedAt ? (
                      <span className="text-muted-foreground">Written {formatRelative(excel.data.workbook.lastPushedAt)}</span>
                    ) : (
                      <span className="text-muted-foreground">Not written yet</span>
                    )}
                  </div>
                  {canManage ? (
                    <Button disabled={edits.sync.isPending || !excel.data.workbook.enabled || excel.data.connection?.status !== 'CONNECTED'} onClick={syncNow} size="sm" variant="outline">
                      {edits.sync.isPending ? 'Writing…' : 'Write now'}
                    </Button>
                  ) : null}
                </div>
              </>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
