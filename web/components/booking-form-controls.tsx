'use client';

import { PlusIcon, XIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';

/**
 * The small controls the create form's Services and Book in Jobber cards share:
 * a labelled checkbox, a list of rows with an add button, and a row's remove
 * button.
 */

export function CheckRow({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex min-h-9 cursor-pointer items-center gap-2 text-sm">
      <Checkbox checked={checked} onCheckedChange={(next) => onChange(next === true)} />
      {label}
    </label>
  );
}

export function Rows({
  label,
  description,
  addLabel,
  onAdd,
  children,
}: {
  label: string;
  description: string;
  addLabel: string;
  onAdd: () => void;
  children: ReactNode;
}) {
  return (
    <fieldset className="grid gap-2">
      <legend className="text-sm font-medium">{label}</legend>
      <p className="text-muted-foreground text-xs">{description}</p>
      {children}
      <Button className="w-fit" onClick={onAdd} size="sm" type="button" variant="outline">
        <PlusIcon />
        {addLabel}
      </Button>
    </fieldset>
  );
}

export function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button aria-label={label} onClick={onClick} size="icon" type="button" variant="ghost">
      <XIcon />
    </Button>
  );
}
