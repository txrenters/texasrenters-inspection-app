'use client';

import {
  APPROVAL_STEP_APPROVERS,
  APPROVAL_STEP_APPROVER_LABEL,
  FILE_GROUPS,
  FILE_GROUP_KEYS,
  FILE_REMOVALS,
  FILE_REMOVAL_LABEL,
  FILE_SIZE_CHOICES,
  MOST_APPROVAL_STEPS,
  MOST_FILES_A_REQUISITION,
  MOST_REQUISITION_QUOTES,
  REMINDER_DAY_CHOICES,
  approvalStepFromCents,
  approvalStepsProblem,
  documentSeriesProblem,
  fileGroupsSaying,
  fileRulesProblem,
  formatDocumentNumber,
  formatFileSize,
  formatMoney,
  parseMoney,
  reminderSaying,
  type ApprovalStep,
  type ApprovalStepApprover,
  type DocumentSeriesSetting,
  type FileGroup,
  type FileRemoval,
  type PurchasingApprovals,
  type RequisitionFileRules,
} from '@texasrenters/shared';
import { ChevronDownIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';

import { FastTab } from '@/components/purchasing/nav-kit';
import { ErrorState, PageSkeleton } from '@/components/states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { usePurchasingSetup, usePurchasingSetupEdits } from '@/lib/purchasing-queries';

/**
 * Purchasing > Setup (2026-11-20, part 5a), as the approved PurchasingSetup
 * board draws it: the approval steps by amount and the switches beside them,
 * the document numbers, and the rules for files on a requisition. Only a
 * system admin or a Purchasing admin sees it.
 *
 * Saved as you go: a choice saves when it is made, a typed value when its box
 * is left, and only when it is one the office may keep -- the same rules the
 * server checks. The roles, the code lists and the requisition page's own
 * section come in the next parts (5b, 5c).
 */
export function SetupTab({ enabled }: { enabled: boolean }) {
  const setup = usePurchasingSetup(enabled);
  if (setup.isLoading) return <PageSkeleton />;
  if (setup.isError || !setup.data) return <ErrorState error={setup.error} retry={() => void setup.refetch()} />;
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-heading text-xl font-medium">Purchasing Setup</h2>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="warning">System admin and Purchasing admin only</Badge>
          <span className="text-muted-foreground text-sm">Changes are saved as you go</span>
        </div>
      </div>
      <p className="text-muted-foreground text-sm">Roles and who holds them, the code lists and the requisition page&rsquo;s fields come with the next parts of Setup.</p>
      {/* Keyed on what the server holds, so a save from elsewhere starts each section afresh. */}
      <ApprovalsSection approvals={setup.data.approvals} key={JSON.stringify(setup.data.approvals)} />
      <NumbersSection numbers={setup.data.numbers} />
      <FilesSection files={setup.data.files} key={JSON.stringify(setup.data.files)} />
      <p className="text-muted-foreground text-sm">Every change here is written to the audit log: who, when, what it was and what it became.</p>
    </div>
  );
}

/** What a save is doing, for the line under a section. */
function SaveStatus({ pending, error, problem }: { pending: boolean; error: Error | null; problem: string | null }) {
  if (problem)
    return (
      <p className="text-warning text-sm font-medium" role="status">
        {problem} Not saved.
      </p>
    );
  if (error)
    return (
      <Alert variant="destructive">
        <AlertDescription>{error.message}</AlertDescription>
      </Alert>
    );
  return (
    <p aria-live="polite" className="text-muted-foreground text-xs">
      {pending ? 'Saving…' : ' '}
    </p>
  );
}

// ── Approvals ────────────────────────────────────────────────────────────────

interface StepDraft {
  key: string;
  upTo: string;
  approver: ApprovalStepApprover;
  quotes: string;
  reminderDays: number | null;
}

let drafts = 0;
const toDraft = (step: ApprovalStep): StepDraft => ({
  key: `step-${(drafts += 1)}`,
  upTo: step.upToCents === null ? '' : (step.upToCents / 100).toFixed(2),
  approver: step.approver,
  quotes: String(step.quotesNeeded),
  reminderDays: step.reminderDays,
});

/** The drafts as steps, or why they are not yet. */
function parseSteps(rows: readonly StepDraft[]): { steps: ApprovalStep[]; problem: string | null } {
  const steps: ApprovalStep[] = [];
  for (const [index, row] of rows.entries()) {
    const last = index === rows.length - 1;
    const upToCents = last ? null : parseMoney(row.upTo);
    if (!last && upToCents === null) return { steps, problem: `Step ${index + 1} needs its top, in dollars.` };
    if (!/^\d+$/.test(row.quotes.trim())) return { steps, problem: `Quotes needed on step ${index + 1} is a whole number.` };
    steps.push({ upToCents, approver: row.approver, quotesNeeded: Number(row.quotes), reminderDays: row.reminderDays });
  }
  return { steps, problem: approvalStepsProblem(steps, MOST_REQUISITION_QUOTES) };
}

function ApprovalsSection({ approvals }: { approvals: PurchasingApprovals }) {
  const { approvals: save } = usePurchasingSetupEdits();
  const [rows, setRows] = useState(() => approvals.steps.map(toDraft));
  const [switches, setSwitches] = useState({ emailApprovers: approvals.emailApprovers, reapproveChangedOrders: approvals.reapproveChangedOrders });
  const parsed = parseSteps(rows);

  /** Saves what the page shows, when the office may keep it and it is not what is saved already. */
  const commit = (nextRows = rows, nextSwitches = switches) => {
    const { steps, problem } = parseSteps(nextRows);
    if (problem) return;
    const input = { steps, ...nextSwitches };
    if (JSON.stringify(input) === JSON.stringify({ steps: approvals.steps, emailApprovers: approvals.emailApprovers, reapproveChangedOrders: approvals.reapproveChangedOrders })) return;
    save.mutate(input);
  };
  const change = (index: number, patch: Partial<StepDraft>, now = false) => {
    const next = rows.map((row, at) => (at === index ? { ...row, ...patch } : row));
    setRows(next);
    if (now) commit(next);
  };
  const addStep = () => {
    // A new step before the last, a thousand dollars above the one before it, as that one is approved.
    const before = rows.length > 1 ? rows[rows.length - 2]! : null;
    const top = (before ? (parseMoney(before.upTo) ?? 0) : 0) + 100_000;
    const added = { ...toDraft({ upToCents: top, approver: before?.approver ?? 'ANY_APPROVER', quotesNeeded: Number(before?.quotes ?? 0) || 0, reminderDays: before?.reminderDays ?? null }) };
    const next = [...rows.slice(0, -1), added, rows.at(-1)!];
    setRows(next);
    commit(next);
  };
  const removeStep = (index: number) => {
    const next = rows.filter((_, at) => at !== index);
    setRows(next);
    commit(next);
  };
  const toggle = (which: keyof typeof switches, on: boolean) => {
    const next = { ...switches, [which]: on };
    setSwitches(next);
    commit(rows, next);
  };

  return (
    <FastTab action={<span className="text-muted-foreground text-xs">Replaces the single approval limit</span>} title="Approvals">
      <div className="grid gap-3">
        <div className="overflow-x-auto">
          <Table>
            {/* Static: the console's sticky header covers the first row inside a sideways scroll box. */}
            <TableHeader className="lg:static">
              <TableRow>
                <TableHead>From</TableHead>
                <TableHead>Up to</TableHead>
                <TableHead>Who approves</TableHead>
                <TableHead>Quotes needed</TableHead>
                <TableHead>Reminder</TableHead>
                <TableHead className="w-10">
                  <span className="sr-only">Remove</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, index) => {
                const last = index === rows.length - 1;
                const from = parsed.problem ? null : approvalStepFromCents(parsed.steps, index);
                return (
                  <TableRow key={row.key}>
                    <TableCell className="whitespace-nowrap tabular-nums">{from === null ? '—' : formatMoney(from)}</TableCell>
                    <TableCell>
                      {last ? (
                        <span className="text-muted-foreground">No limit</span>
                      ) : (
                        <Input
                          aria-label={`Step ${index + 1}: up to, in dollars`}
                          className="w-32 tabular-nums"
                          inputMode="decimal"
                          onBlur={() => commit()}
                          onChange={(event) => change(index, { upTo: event.target.value })}
                          value={row.upTo}
                        />
                      )}
                    </TableCell>
                    <TableCell>
                      <Select onValueChange={(approver) => change(index, { approver: approver as ApprovalStepApprover }, true)} value={row.approver}>
                        <SelectTrigger aria-label={`Step ${index + 1}: who approves`} className="w-56">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {APPROVAL_STEP_APPROVERS.map((approver) => (
                            <SelectItem key={approver} value={approver}>
                              {APPROVAL_STEP_APPROVER_LABEL[approver]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <Input
                        aria-label={`Step ${index + 1}: quotes needed`}
                        className="w-16 tabular-nums"
                        inputMode="numeric"
                        onBlur={() => commit()}
                        onChange={(event) => change(index, { quotes: event.target.value })}
                        value={row.quotes}
                      />
                    </TableCell>
                    <TableCell>
                      <Select onValueChange={(days) => change(index, { reminderDays: days === 'none' ? null : Number(days) }, true)} value={row.reminderDays === null ? 'none' : String(row.reminderDays)}>
                        <SelectTrigger aria-label={`Step ${index + 1}: reminder`} className="w-36">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {REMINDER_DAY_CHOICES.map((days) => (
                            <SelectItem key={days ?? 'none'} value={days === null ? 'none' : String(days)}>
                              {reminderSaying(days)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      {last ? null : (
                        <Button aria-label={`Remove step ${index + 1}`} onClick={() => removeStep(index)} size="icon" variant="ghost">
                          <Trash2Icon />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        <div>
          <Button disabled={rows.length >= MOST_APPROVAL_STEPS} onClick={addStep} size="sm" variant="outline">
            <PlusIcon /> Add a step
          </Button>
        </div>
        <div className="grid gap-x-8 gap-y-2 md:grid-cols-2">
          <SwitchRow checked disabled label="Nobody approves their own requisition (always on)" />
          <SwitchRow checked={switches.emailApprovers} label="Email the approver when one is sent" onChange={(on) => toggle('emailApprovers', on)} />
          <SwitchRow
            checked={switches.reapproveChangedOrders}
            hint="Off: only a change that raises it, adds an item or changes the vendor goes back for approval."
            label="A purchase order is approved again when it changes"
            onChange={(on) => toggle('reapproveChangedOrders', on)}
          />
        </div>
        <p className="text-muted-foreground text-xs">A reminder emails the approvers once, if the requisition still waits after its step&rsquo;s days.</p>
        <SaveStatus error={save.error} pending={save.isPending} problem={parsed.problem} />
      </div>
    </FastTab>
  );
}

function SwitchRow({ label, hint, checked, disabled, onChange }: { label: string; hint?: string; checked: boolean; disabled?: boolean; onChange?: (on: boolean) => void }) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <Switch checked={checked} disabled={disabled} id={id} onCheckedChange={onChange} />
      <div className="grid gap-0.5">
        <Label htmlFor={id}>{label}</Label>
        {hint ? <span className="text-muted-foreground text-xs">{hint}</span> : null}
      </div>
    </div>
  );
}

// ── Numbers ──────────────────────────────────────────────────────────────────

function NumbersSection({ numbers }: { numbers: DocumentSeriesSetting[] }) {
  return (
    <FastTab title="Numbers">
      <div className="grid gap-3">
        <div className="overflow-x-auto">
          <Table>
            {/* Static: the console's sticky header covers the first row inside a sideways scroll box. */}
            <TableHeader className="lg:static">
              <TableRow>
                <TableHead>Document</TableHead>
                <TableHead>Prefix</TableHead>
                <TableHead>Digits</TableHead>
                <TableHead>Next number</TableHead>
                <TableHead>Example</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {numbers.map((series) => (
                <SeriesRow key={`${series.kind}-${series.prefix}-${series.digits}-${series.next}`} series={series} />
              ))}
            </TableBody>
          </Table>
        </div>
        <p className="text-muted-foreground text-sm">A next number can only go up, so a number is never given twice. Numbers are never typed on a document; a change applies to the next one given.</p>
      </div>
    </FastTab>
  );
}

function SeriesRow({ series }: { series: DocumentSeriesSetting }) {
  const { series: save } = usePurchasingSetupEdits();
  const [prefix, setPrefix] = useState(series.prefix);
  const [digits, setDigits] = useState(String(series.digits));
  const [next, setNext] = useState(String(series.next));
  const input = { prefix: prefix.trim(), digits: Number(digits), next: Number(next) };
  const problem = /^\d+$/.test(digits.trim()) && /^\d+$/.test(next.trim()) ? documentSeriesProblem(input, series.next) : 'Digits and the next number are whole numbers.';
  const commit = () => {
    if (problem || (input.prefix === series.prefix && input.digits === series.digits && input.next === series.next)) return;
    save.mutate({ kind: series.kind, input });
  };
  const failed = save.error?.message;
  return (
    <TableRow>
      <TableCell className="whitespace-nowrap">
        {series.label}
        {problem || failed ? (
          <p className="text-warning text-xs font-medium" role="status">
            {problem ?? failed}
          </p>
        ) : null}
      </TableCell>
      <TableCell>
        <Input aria-label={`${series.label}: prefix`} className="w-24 font-mono uppercase" onBlur={commit} onChange={(event) => setPrefix(event.target.value.toUpperCase())} value={prefix} />
      </TableCell>
      <TableCell>
        <Input aria-label={`${series.label}: digits`} className="w-16 tabular-nums" inputMode="numeric" onBlur={commit} onChange={(event) => setDigits(event.target.value)} value={digits} />
      </TableCell>
      <TableCell>
        <Input aria-label={`${series.label}: next number`} className="w-28 tabular-nums" inputMode="numeric" onBlur={commit} onChange={(event) => setNext(event.target.value)} value={next} />
      </TableCell>
      <TableCell className="font-mono whitespace-nowrap">{problem ? '—' : formatDocumentNumber(input.prefix, input.digits, input.next)}</TableCell>
    </TableRow>
  );
}

// ── Attachments ──────────────────────────────────────────────────────────────

function FilesSection({ files }: { files: RequisitionFileRules }) {
  const { files: save } = usePurchasingSetupEdits();
  const [rules, setRules] = useState(files);
  const [most, setMost] = useState(String(files.maxFiles));
  const [quote, setQuote] = useState(files.quoteFileAboveCents === null ? '' : (files.quoteFileAboveCents / 100).toFixed(2));
  const typed = (() => {
    if (!/^\d+$/.test(most.trim())) return { rules, problem: 'Most files is a whole number.' };
    const quoteFileAboveCents = quote.trim() ? parseMoney(quote) : null;
    if (quote.trim() && quoteFileAboveCents === null) return { rules, problem: 'The amount for a quote is in dollars, or blank for never.' };
    const next = { ...rules, maxFiles: Number(most), quoteFileAboveCents };
    return { rules: next, problem: fileRulesProblem(next) };
  })();
  const commit = (next = typed.rules) => {
    if (fileRulesProblem(next) || typed.problem) return;
    if (JSON.stringify(next) === JSON.stringify(files)) return;
    save.mutate(next);
  };
  const choose = (patch: Partial<RequisitionFileRules>) => {
    const next = { ...typed.rules, ...patch };
    setRules({ ...rules, ...patch });
    commit(next);
  };
  const toggleGroup = (group: FileGroup, on: boolean) => {
    const groups = FILE_GROUP_KEYS.filter((key) => (key === group ? on : rules.groups.includes(key)));
    if (groups.length) choose({ groups });
  };

  return (
    <FastTab title="Attachments">
      <div className="grid gap-3">
        <div className="grid gap-x-8 gap-y-3 md:grid-cols-2">
          <FieldLine label="File types">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button aria-label="File types" className="h-auto min-h-9 w-full justify-between py-1.5 text-left font-normal whitespace-normal" variant="outline">
                  <span>{fileGroupsSaying(rules.groups)}</span>
                  <ChevronDownIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {FILE_GROUP_KEYS.map((group) => (
                  <DropdownMenuCheckboxItem checked={rules.groups.includes(group)} key={group} onCheckedChange={(on) => toggleGroup(group, on === true)} onSelect={(event) => event.preventDefault()}>
                    {FILE_GROUPS[group].label}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </FieldLine>
          <FieldLine label="Quote attached above">
            <Input aria-label="Quote attached above, in dollars" inputMode="decimal" onBlur={() => commit()} onChange={(event) => setQuote(event.target.value)} placeholder="Never" value={quote} />
          </FieldLine>
          <FieldLine label="Largest file">
            <Select onValueChange={(bytes) => choose({ maxBytes: Number(bytes) })} value={String(rules.maxBytes)}>
              <SelectTrigger aria-label="Largest file" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FILE_SIZE_CHOICES.map((bytes) => (
                  <SelectItem key={bytes} value={String(bytes)}>
                    {formatFileSize(bytes)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldLine>
          <FieldLine label="Who may remove a file">
            <Select onValueChange={(removal) => choose({ removal: removal as FileRemoval })} value={rules.removal}>
              <SelectTrigger aria-label="Who may remove a file" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FILE_REMOVALS.map((removal) => (
                  <SelectItem key={removal} value={removal}>
                    {FILE_REMOVAL_LABEL[removal]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldLine>
          <FieldLine label="Most files on one requisition">
            <Input aria-label="Most files on one requisition" inputMode="numeric" max={MOST_FILES_A_REQUISITION} onBlur={() => commit()} onChange={(event) => setMost(event.target.value)} value={most} />
          </FieldLine>
          <FieldLine label="Kept for">
            <span className="text-sm">As long as the requisition</span>
          </FieldLine>
        </div>
        <p className="text-muted-foreground text-sm">
          A requisition over the amount cannot be sent until a quote is attached. Files ticked &ldquo;Send to the vendor&rdquo; go with the purchase order email.
        </p>
        <SaveStatus error={save.error} pending={save.isPending} problem={typed.problem} />
      </div>
    </FastTab>
  );
}

function FieldLine({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid items-center gap-1 sm:grid-cols-[13rem_minmax(0,1fr)] sm:gap-3">
      <span className="text-sm">{label}:</span>
      {children}
    </div>
  );
}
