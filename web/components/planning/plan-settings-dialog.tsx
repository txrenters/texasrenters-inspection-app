'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { formatMinutes } from '@/lib/planning';
import type { PlanSettings } from '@/lib/planning-queries';

/** The office's rules as it stated them on 2026-09-16, and the visit lengths a new plan starts from. */
export const DEFAULT_PLAN_SETTINGS: PlanSettings = {
  occupiedVisitMinutes: 30,
  hvacVisitMinutes: 45,
  maxOnSiteMinutes: 360,
  maxDriveMinutes: 90,
  holidays: [],
};

/** The ranges the API accepts, so a typo is caught here rather than refused after a click. */
const RANGES = {
  occupiedVisitMinutes: [5, 240],
  hvacVisitMinutes: [5, 240],
  maxOnSiteMinutes: [30, 720],
  maxDriveMinutes: [0, 480],
} as const;

type NumberField = keyof typeof RANGES;

/** Closed days typed one per line, or separated by commas. */
export function readClosedDays(text: string): { days: string[]; invalid: string[] } {
  const entries = text
    .split(/[\s,;]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const valid = (entry: string) => /^\d{4}-\d{2}-\d{2}$/.test(entry) && !Number.isNaN(Date.parse(`${entry}T00:00:00Z`));
  return {
    days: [...new Set(entries.filter(valid))].sort(),
    invalid: entries.filter((entry) => !valid(entry)),
  };
}

export function PlanSettingsDialog({
  open,
  onOpenChange,
  title,
  description,
  initial,
  submitLabel,
  pending,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  initial: PlanSettings;
  submitLabel: string;
  pending: boolean;
  onSubmit: (settings: PlanSettings) => void;
}) {
  const [values, setValues] = useState<Record<NumberField, string>>(() => toText(initial));
  const [closedDays, setClosedDays] = useState(initial.holidays.join('\n'));

  // Reset to the plan's values as the dialog opens, so a cancelled edit does not
  // come back the next time -- and only then, so a refetch of the plan behind
  // an open dialog does not wipe what is being typed.
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setValues(toText(initial));
      setClosedDays(initial.holidays.join('\n'));
    }
    wasOpen.current = open;
  }, [open, initial]);

  const problems = (Object.keys(RANGES) as NumberField[]).flatMap((field) => {
    const [min, max] = RANGES[field];
    const value = Number(values[field]);
    return Number.isInteger(value) && value >= min && value <= max ? [] : [field];
  });
  const closed = readClosedDays(closedDays);
  const valid = problems.length === 0 && closed.invalid.length === 0;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    onSubmit({
      occupiedVisitMinutes: Number(values.occupiedVisitMinutes),
      hvacVisitMinutes: Number(values.hvacVisitMinutes),
      maxOnSiteMinutes: Number(values.maxOnSiteMinutes),
      maxDriveMinutes: Number(values.maxDriveMinutes),
      holidays: closed.days,
    });
  };

  const number = (field: NumberField, label: string, hint: string) => (
    <Field>
      <FieldLabel htmlFor={`plan-${field}`}>{label}</FieldLabel>
      <Input
        aria-invalid={problems.includes(field) || undefined}
        id={`plan-${field}`}
        inputMode="numeric"
        max={RANGES[field][1]}
        min={RANGES[field][0]}
        onChange={(event) => setValues((current) => ({ ...current, [field]: event.target.value }))}
        type="number"
        value={values[field]}
      />
      <FieldDescription>
        {problems.includes(field)
          ? `A whole number of minutes from ${RANGES[field][0]} to ${RANGES[field][1]}.`
          : hint}
      </FieldDescription>
    </Field>
  );

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-lg">
        <form className="grid gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>

          <FieldGroup className="grid gap-4 sm:grid-cols-2">
            {number('occupiedVisitMinutes', 'Occupied inspection', 'Minutes on site, filter change and pest control included.')}
            {number('hvacVisitMinutes', 'HVAC inspection', 'Minutes on site, filter change and pest control included.')}
            {number(
              'maxOnSiteMinutes',
              'Inspecting in a day',
              `At most ${formatMinutes(Number(values.maxOnSiteMinutes) || 0)} on site per technician-day.`,
            )}
            {number(
              'maxDriveMinutes',
              'Driving in a day',
              'Minutes between the day’s properties. The drive from home is not counted.',
            )}
          </FieldGroup>

          <Field>
            <FieldLabel htmlFor="plan-closed-days">Closed days</FieldLabel>
            <Textarea
              aria-invalid={closed.invalid.length > 0 || undefined}
              id="plan-closed-days"
              onChange={(event) => setClosedDays(event.target.value)}
              placeholder={'2026-11-26\n2026-11-27\n2026-12-25'}
              rows={3}
              value={closedDays}
            />
            <FieldDescription>
              {closed.invalid.length
                ? `Not a date: ${closed.invalid.join(', ')}. Write each as YYYY-MM-DD.`
                : 'Weekdays nobody is sent out, one per line. Weekends are never planned.'}
            </FieldDescription>
          </Field>

          <DialogFooter>
            <Button onClick={() => onOpenChange(false)} type="button" variant="outline">
              Cancel
            </Button>
            <Button disabled={!valid || pending} type="submit">
              {pending ? <Spinner /> : null}
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function toText(settings: PlanSettings): Record<NumberField, string> {
  return {
    occupiedVisitMinutes: String(settings.occupiedVisitMinutes),
    hvacVisitMinutes: String(settings.hvacVisitMinutes),
    maxOnSiteMinutes: String(settings.maxOnSiteMinutes),
    maxDriveMinutes: String(settings.maxDriveMinutes),
  };
}
