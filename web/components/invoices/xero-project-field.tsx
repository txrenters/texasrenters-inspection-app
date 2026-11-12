'use client';

import { XERO_PROJECT_NAME_MAX, parseMoney, type XeroVisitCompanyProjects, type XeroVisitProjects } from '@texasrenters/shared';
import { PlusIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { toast } from 'sonner';

import { formatInvoiceDay } from '@/components/invoices/invoice-parts';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { newClientRequestId } from '@/lib/invoice-queries';
import { useXeroProjectActions } from '@/lib/xero-queries';

/** A contact's initials, as Xero badges one: "6510 Gardners Brk" is 6GB. */
export const contactInitials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');

/**
 * The invoice's Project (2026-11-13), as Xero's invoice has one: a project in
 * progress in the company's books under the property, chosen at once; or a new
 * one, made in Xero at once from the New project dialog -- the office makes the
 * project first, then the invoice. Xero's API cannot put the invoice on it, so
 * the office picks the same project on the draft in Xero before approving.
 */
export function XeroProjectField({ visit, company }: { visit: XeroVisitProjects; company: XeroVisitCompanyProjects }) {
  const id = useId();
  const actions = useXeroProjectActions(visit.inspectionId);
  const [making, setMaking] = useState(false);
  const chosen = company.chosen;
  // The visit's own stays offered once closed in Xero, so the field still says which it is.
  const options = chosen && !company.projects.some((project) => project.xeroProjectId === chosen.xeroProjectId) ? [chosen, ...company.projects] : company.projects;
  const choose = (xeroProjectId: string) =>
    actions.choose.mutate(
      { tenantId: company.tenantId, xeroProjectId },
      {
        onSuccess: (project) => toast.success('Project chosen', { description: project.name }),
        onError: (error) => toast.error('The project was not chosen', { description: error.message }),
      },
    );

  return (
    <div className="border-b px-4 py-3">
      <Field>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <FieldLabel htmlFor={`${id}-project`}>Project</FieldLabel>
          <Button className="h-auto px-1 py-0" disabled={Boolean(company.problem)} onClick={() => setMaking(true)} size="sm" variant="link">
            <PlusIcon />
            New project
          </Button>
        </div>
        <Select disabled={!options.length || actions.choose.isPending} onValueChange={choose} value={chosen?.xeroProjectId ?? ''}>
          <SelectTrigger aria-label={`Project in ${company.name}`} className="w-full" id={`${id}-project`}>
            <SelectValue placeholder={options.length ? 'Choose a project' : 'No project in progress for this property yet'} />
          </SelectTrigger>
          <SelectContent>
            {options.map((project) => (
              <SelectItem key={project.xeroProjectId} value={project.xeroProjectId}>
                {project.name}
                {project.status === 'CLOSED' ? ' (closed)' : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription aria-live="polite" className={company.problem ? 'text-destructive' : undefined}>
          {company.problem ??
            (chosen
              ? `Due ${chosen.deadlineOn ? formatInvoiceDay(chosen.deadlineOn) : '—'}. Xero’s API can’t put the invoice on it: pick this project on the draft in Xero before you approve it.`
              : 'Make the visit’s project first, as in Xero, or choose one already there.')}
        </FieldDescription>
      </Field>
      <NewXeroProjectDialog company={company} onClose={() => setMaking(false)} open={making} visit={visit} />
    </div>
  );
}

/**
 * "New in progress project", as Xero's dialog has it: the property as its
 * contact, the name the office gives them, due on the day the visit was
 * finished, and an estimate if any. Made in the company's books at once and
 * chosen for the invoice; one already in progress there under the same name is
 * chosen instead.
 */
export function NewXeroProjectDialog({
  visit,
  company,
  open,
  onClose,
}: {
  visit: XeroVisitProjects;
  company: XeroVisitCompanyProjects;
  open: boolean;
  onClose: () => void;
}) {
  const id = useId();
  const actions = useXeroProjectActions(visit.inspectionId);
  const [name, setName] = useState(visit.suggestedName ?? '');
  const [deadlineOn, setDeadlineOn] = useState(visit.deadlineOn);
  const [estimate, setEstimate] = useState('');
  // One key a time the dialog opens: a double click makes one project.
  const [requestId, setRequestId] = useState(newClientRequestId);

  // Filled afresh each time it opens.
  const [opened, setOpened] = useState(false);
  if (open && !opened) {
    setOpened(true);
    setName(visit.suggestedName ?? '');
    setDeadlineOn(visit.deadlineOn);
    setEstimate('');
    setRequestId(newClientRequestId());
  }
  if (!open && opened) setOpened(false);

  const estimateCents = estimate.trim() ? parseMoney(estimate) : null;
  const problem = !name.trim()
    ? visit.suggestedName === null
      ? 'The visit has no technician: give the project its name.'
      : 'Give the project a name.'
    : name.trim().length > XERO_PROJECT_NAME_MAX
      ? `Keep the name to ${XERO_PROJECT_NAME_MAX} characters.`
      : !deadlineOn
        ? 'Give the project a deadline.'
        : estimate.trim() && estimateCents === null
          ? 'Give the estimate in dollars and cents.'
          : null;

  const create = () => {
    if (problem) return;
    actions.make.mutate(
      { tenantId: company.tenantId, input: { inspectionId: visit.inspectionId, name: name.trim(), deadlineOn, estimateCents, clientRequestId: requestId } },
      {
        onSuccess: ({ project, found }) => {
          toast.success(found ? 'Already in Xero, and chosen' : 'Project created in Xero', { description: `${project.name} · ${company.name}` });
          onClose();
        },
        onError: (error) => toast.error('The project was not created', { description: error.message }),
      },
    );
  };

  return (
    <Dialog onOpenChange={(next) => (next ? undefined : onClose())} open={open}>
      <DialogContent
        onOpenAutoFocus={(event) => {
          // The name, not the contact, which is not the office's to change.
          event.preventDefault();
          document.getElementById(`${id}-name`)?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>New in progress project</DialogTitle>
          <DialogDescription>Made in {company.name}’s books in Xero at once, and chosen for this invoice.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Field>
            <FieldLabel htmlFor={`${id}-contact`}>
              Contact <span className="text-muted-foreground font-normal">(required)</span>
            </FieldLabel>
            <div className="relative">
              <span aria-hidden="true" className="bg-warning/20 text-heading absolute top-1/2 left-1.5 -translate-y-1/2 rounded px-1.5 py-0.5 text-xs font-bold">
                {contactInitials(visit.contactName)}
              </span>
              <Input className="bg-muted pl-14" id={`${id}-contact`} readOnly value={visit.contactName} />
            </div>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-name`}>Project name</FieldLabel>
            <Input id={`${id}-name`} maxLength={XERO_PROJECT_NAME_MAX} onChange={(event) => setName(event.target.value)} value={name} />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-deadline`}>Deadline</FieldLabel>
            <Input id={`${id}-deadline`} onChange={(event) => setDeadlineOn(event.target.value)} type="date" value={deadlineOn} />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-estimate`}>Estimate</FieldLabel>
            <Input
              className="text-right tabular-nums"
              id={`${id}-estimate`}
              inputMode="decimal"
              onChange={(event) => setEstimate(event.target.value)}
              placeholder="e.g. 10,000.00"
              value={estimate}
            />
            <FieldDescription className="text-right">excl. tax</FieldDescription>
          </Field>
          <p aria-live="polite" className={problem ? 'text-destructive text-sm' : 'text-muted-foreground text-sm'}>
            {problem ?? 'Who can see it, and its tasks and expenses, stay Xero’s to set.'}
          </p>
        </div>
        <DialogFooter>
          <Button onClick={onClose} variant="secondary">
            Cancel
          </Button>
          <Button disabled={Boolean(problem) || actions.make.isPending} onClick={create}>
            {actions.make.isPending ? 'Creating…' : 'Create project'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
