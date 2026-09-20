'use client';

import { SparklesIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

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
import { Spinner } from '@/components/ui/spinner';
import { formatShortDay } from '@/lib/planning';
import type { PlanAdvice } from '@/lib/planning-queries';

/**
 * What AI makes of a built quarter, and the moves the office may take from it.
 *
 * The office (2026-09-20): "can you integrate ai into this also cause I have
 * openai integrated already with the system". It reads the days and says what
 * looks wrong in the office's own terms -- which is the sentence they write
 * themselves when they reject a quarter -- and proposes moves.
 *
 * Nothing here is trusted: every move was already judged on the server against
 * the office's rules, and only the ones that break none, and shorten the
 * driving, are offered. Applying judges them again.
 */
export function PlanAdviceDialog({
  open,
  onOpenChange,
  label,
  advice,
  loading,
  error,
  applying,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** "Q4 2026". */
  label: string;
  advice: PlanAdvice | null;
  loading: boolean;
  error: string | null;
  applying: boolean;
  onApply: (moves: { stopId: string; toDate: string; toTechnicianId: string }[]) => void;
}) {
  const [taken, setTaken] = useState<Set<string>>(new Set());

  // Every move offered is ticked when new advice arrives: the office asked for
  // the shortest driving, and each of these is measured to give it.
  useEffect(() => {
    setTaken(new Set((advice?.moves ?? []).map((move) => move.stopId)));
  }, [advice]);

  const moves = (advice?.moves ?? []).filter((move) => taken.has(move.stopId));
  const saved = moves.reduce((total, move) => total + move.savedMinutes, 0);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>What AI makes of {label}</DialogTitle>
          <DialogDescription>
            It reads the quarter and says what looks wrong, then proposes moves. Only the moves that keep every rule —
            the 20 minutes between properties, the day&rsquo;s visits, its six hours, a qualified technician — and
            shorten the driving are offered here.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="grid gap-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-1/2" />
            <p className="text-muted-foreground text-xs">Reading the quarter. This takes a few seconds.</p>
          </div>
        ) : error ? (
          <p className="text-destructive text-sm">{error}</p>
        ) : advice ? (
          <div className="grid max-h-[50vh] gap-4 overflow-y-auto pr-1">
            {advice.notes.length ? (
              <section className="grid gap-1.5">
                <h3 className="text-sm font-medium">What it says</h3>
                <ul className="text-muted-foreground grid gap-1 text-sm">
                  {advice.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              </section>
            ) : null}

            <section className="grid gap-2">
              <h3 className="text-sm font-medium">
                {advice.moves.length ? `${advice.moves.length} moves worth making` : 'No move worth making'}
              </h3>
              {advice.moves.length ? (
                <ul className="grid gap-2">
                  {advice.moves.map((move) => (
                    <li className="flex items-start gap-2" key={move.stopId}>
                      <Checkbox
                        aria-label={`Move ${move.address ?? 'this visit'} to ${formatShortDay(move.toDate)}`}
                        checked={taken.has(move.stopId)}
                        className="mt-0.5"
                        id={`advice-${move.stopId}`}
                        onCheckedChange={(checked) =>
                          setTaken((current) => {
                            const next = new Set(current);
                            if (checked) next.add(move.stopId);
                            else next.delete(move.stopId);
                            return next;
                          })
                        }
                      />
                      <label className="grid min-w-0 gap-0.5 text-sm" htmlFor={`advice-${move.stopId}`}>
                        <span className="truncate">
                          {move.address ?? 'A visit'} → {formatShortDay(move.toDate)}, {move.toTechnicianName}
                          <span className="text-success"> · saves {move.savedMinutes} min</span>
                        </span>
                        {move.why ? <span className="text-muted-foreground text-xs">{move.why}</span> : null}
                      </label>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground text-sm">
                  The quarter is already grouped as tightly as these rules allow.
                </p>
              )}
            </section>

            {advice.refused.length ? (
              <details className="text-muted-foreground text-xs">
                <summary className="cursor-pointer">
                  {advice.refused.length} of its {advice.proposed} moves the rules refused
                </summary>
                <ul className="mt-1 grid gap-1">
                  {advice.refused.map((move, index) => (
                    <li key={`${move.stopId}-${index}`}>
                      {move.address ?? move.stopId} → {formatShortDay(move.toDate)}: {move.refused}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}

            <p className="text-muted-foreground text-xs">
              {advice.modelId}
              {advice.usage ? ` · ${advice.usage.totalTokens.toLocaleString()} tokens` : ''}
            </p>
          </div>
        ) : null}

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} variant="outline">
            Close
          </Button>
          <Button disabled={applying || moves.length === 0} onClick={() => onApply(moves.map(({ stopId, toDate, toTechnicianId }) => ({ stopId, toDate, toTechnicianId })))}>
            {applying ? <Spinner /> : <SparklesIcon />}
            {moves.length ? `Apply ${moves.length} ${moves.length === 1 ? 'move' : 'moves'} · ${saved} min` : 'Apply'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
