'use client';

import { FileSpreadsheetIcon } from 'lucide-react';
import { useRef, useState, type ChangeEvent } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { readOfficeSheet } from '@/lib/planning';
import { usePlanningMutations, type OfficeDetailsAddress, type OfficeDetailsImport } from '@/lib/planning-queries';

/**
 * The office's sheet of visit Details, taken into a draft plan.
 *
 * Read in the browser -- the office's own Jobber import sheet, saved as CSV --
 * and only the address and the services line are sent. What did not match is
 * shown straight after, because a row nobody matched is a tenancy whose visit
 * will carry a line written from the tenant report instead of the office's.
 */
export function OfficeSheetImport({ planId, disabled }: { planId: string; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const { importOfficeDetails } = usePlanningMutations();
  const [result, setResult] = useState<(OfficeDetailsImport & { fileName: string; skipped: number }) | null>(null);

  const choose = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const sheet = readOfficeSheet(await file.text());
    if (sheet.missing.length) {
      toast.error(`${file.name} is missing ${sheet.missing.join(' and ')}.`, {
        description: 'Save the office’s Jobber import sheet as CSV and choose it again.',
      });
      return;
    }
    if (!sheet.rows.length) {
      toast.error(`${file.name} has no rows with both an address and Details.`);
      return;
    }
    importOfficeDetails.mutate(
      { planId, rows: sheet.rows },
      {
        onSuccess: (imported) => setResult({ ...imported, fileName: file.name, skipped: sheet.skipped }),
        onError: (error) => toast.error('The sheet could not be imported', { description: error.message }),
      },
    );
  };

  return (
    <>
      <input
        accept=".csv,text/csv"
        aria-label="The office’s sheet of visit Details, as CSV"
        className="hidden"
        onChange={(event) => void choose(event)}
        ref={input}
        type="file"
      />
      <Button
        disabled={disabled || importOfficeDetails.isPending}
        onClick={() => input.current?.click()}
        size="sm"
        variant="outline"
      >
        {importOfficeDetails.isPending ? <Spinner /> : <FileSpreadsheetIcon />}
        Import office sheet
      </Button>

      <Dialog onOpenChange={(open) => !open && setResult(null)} open={Boolean(result)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {result ? `${result.matched.toLocaleString()} of ${result.rows.toLocaleString()} rows matched` : 'Sheet imported'}
            </DialogTitle>
            <DialogDescription>
              {result
                ? [
                    `From ${result.fileName}.`,
                    result.stopsWithoutOfficeDetails
                      ? `${result.stopsWithoutOfficeDetails.toLocaleString()} visits the sheet does not cover get a line written from the tenant report.`
                      : 'Every visit in the plan carries the office’s line.',
                    result.skipped ? `${result.skipped.toLocaleString()} rows had no address or no Details and were left out.` : null,
                  ]
                    .filter(Boolean)
                    .join(' ')
                : null}
            </DialogDescription>
          </DialogHeader>
          {result ? (
            <div className="grid max-h-80 gap-4 overflow-y-auto text-sm">
              <Addresses heading="No tenancy at this address" rows={result.unmatched} />
              <Addresses heading="More than one tenancy at this address, so neither was given it" rows={result.ambiguous} />
              <Addresses heading="A second row for a property already matched" rows={result.duplicates} />
            </div>
          ) : null}
          <DialogFooter>
            <Button onClick={() => setResult(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Addresses({ heading, rows }: { heading: string; rows: OfficeDetailsAddress[] }) {
  if (!rows.length) return null;
  return (
    <section className="grid gap-1.5">
      <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        {heading} ({rows.length})
      </h3>
      <ul className="bg-muted/40 divide-border divide-y rounded-lg border">
        {rows.map((row, index) => (
          <li className="px-3 py-1.5" key={`${row.address}-${index}`}>
            {row.address}
            <span className="text-muted-foreground">{[row.city, row.postalCode].filter(Boolean).length ? `, ${[row.city, row.postalCode].filter(Boolean).join(' ')}` : ''}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
