'use client';

import {
  PURCHASING_CODE_KINDS,
  PURCHASING_CODE_KIND_ABOUT,
  PURCHASING_CODE_KIND_LABEL,
  TRACKED_CODE_KINDS,
  normalizePurchasingCode,
  purchasingCodeProblem,
  type PurchasingCodeKind,
  type PurchasingCodeRow,
  type PurchasingCompanyRow,
  type SavePurchasingCodeInput,
  type XeroOptionMatch,
} from '@texasrenters/shared';
import { TagsIcon } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import { DataTable, DataTableSkeleton, type Column } from '@/components/data-table';
import { InUseBadge } from '@/components/inventory/stock-status';
import { EmptyState, ErrorState } from '@/components/states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { usePurchasingCodeEdits, usePurchasingCodes } from '@/lib/purchasing-codes-queries';

/**
 * Purchasing > Codes (2026-11-20, part 1 of the NAV-style requisition): the
 * lists a requisition is coded with, and each company's purchaser code.
 *
 * Shown only to whoever may manage purchasing codes. A code is kept in
 * capitals, unique in its list, and switched off rather than removed, so a
 * requisition that named it still reads. Department and cost center codes are
 * matched, company by company, to a tracking option in that company's Xero,
 * read from what the console already keeps: nothing here calls Xero.
 */

/** Radix's Select has no empty value: this stands for "not matched". */
const NONE = 'none';
const optionValue = (match: Pick<XeroOptionMatch, 'trackingCategoryId' | 'trackingOptionId'>) => `${match.trackingCategoryId}|${match.trackingOptionId}`;

function columns(kind: PurchasingCodeKind): Array<Column<PurchasingCodeRow>> {
  return [
    { key: 'code', header: 'Code', className: 'whitespace-nowrap', cell: (row) => <span className="font-mono font-semibold">{row.code}</span> },
    { key: 'name', header: 'Name', primary: true, cell: (row) => row.name },
    ...(kind === 'LINE_TYPE'
      ? [
          { key: 'stock', header: 'Keeps stock', cell: (row: PurchasingCodeRow) => (row.keepsStock ? 'Yes' : 'No') },
          { key: 'used', header: 'Item codes', numeric: true, cell: (row: PurchasingCodeRow) => row.used },
        ]
      : []),
    ...(TRACKED_CODE_KINDS.includes(kind)
      ? [{ key: 'xero', header: 'Xero tracking', hideBelow: 'md' as const, cell: (row: PurchasingCodeRow) => (row.xero.length ? row.xero.map((match) => match.label).join(', ') : <span className="text-muted-foreground text-xs">Not matched</span>) }]
      : []),
    { key: 'status', header: 'Status', hideBelow: 'sm', cell: (row) => <InUseBadge active={row.active} /> },
  ];
}

export function CodesTab({ enabled }: { enabled: boolean }) {
  const codes = usePurchasingCodes(enabled);
  const [kind, setKind] = useState<PurchasingCodeKind>('LINE_TYPE');
  const [editing, setEditing] = useState<PurchasingCodeRow | null>(null);

  if (codes.isError) return <ErrorState error={codes.error} retry={() => void codes.refetch()} />;
  if (!codes.data) return <DataTableSkeleton columns={columns('LINE_TYPE')} label="Loading codes" rows={4} />;
  const { companies } = codes.data;
  const rows = codes.data.codes.filter((row) => row.kind === kind);
  // Each list is changed by the role Purchasing Setup gives it (2026-11-21); everybody in purchasing reads them.
  const keeps = codes.data.keeps ?? { LINE_TYPE: true, UNIT: true, REQUEST: true, DEPARTMENT: true, COST_CENTER: true, PURCHASER_CODES: true };

  return (
    <div className="grid gap-8">
      <CompaniesSection canChange={keeps.PURCHASER_CODES} companies={companies} />

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <section aria-labelledby="code-lists-heading" className="grid min-w-0 gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-base font-semibold" id="code-lists-heading">
              Code lists
            </h2>
            <SegmentedControl
              aria-label="Which list"
              onChange={setKind}
              options={PURCHASING_CODE_KINDS.map((value) => ({ value, label: PURCHASING_CODE_KIND_LABEL[value], count: codes.data.codes.filter((row) => row.kind === value).length }))}
              value={kind}
            />
          </div>
          <p className="text-muted-foreground text-sm">{PURCHASING_CODE_KIND_ABOUT[kind]}</p>
          {rows.length ? (
            <DataTable
              actions={
                keeps[kind]
                  ? (row) => (
                      <Button aria-label={`Edit ${row.code}`} onClick={() => setEditing(row)} size="sm" variant="outline">
                        Edit
                      </Button>
                    )
                  : undefined
              }
              columns={columns(kind)}
              label={PURCHASING_CODE_KIND_LABEL[kind]}
              rowKey={(row) => row.id}
              rows={rows}
            />
          ) : (
            <EmptyState description="Add the first one with the form beside this list." icon={TagsIcon} title={`No ${PURCHASING_CODE_KIND_LABEL[kind].toLowerCase()} yet`} />
          )}
        </section>
        {keeps[kind] ? (
          <NewCode companies={companies} key={kind} kind={kind} />
        ) : (
          <p className="text-muted-foreground text-sm">{PURCHASING_CODE_KIND_LABEL[kind]} are kept by somebody else here: Purchasing Setup says who.</p>
        )}
      </div>
      {editing ? <EditCode code={editing} companies={companies} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

// ── Companies ─────────────────────────────────────────────────────────────

function CompaniesSection({ companies, canChange }: { companies: readonly PurchasingCompanyRow[]; canChange: boolean }) {
  return (
    <section aria-labelledby="companies-heading" className="grid gap-3">
      <h2 className="text-base font-semibold" id="companies-heading">
        Purchaser codes
      </h2>
      <p className="text-muted-foreground text-sm">The code each company goes by on a requisition and a purchase order, like THMP.</p>
      {companies.length ? (
        <div className="bg-card divide-y rounded-xl border">
          {companies.map((company) => (
            canChange ? (
              <CompanyCode company={company} key={company.xeroTenantId} />
            ) : (
              <div className="flex items-center justify-between gap-3 px-4 py-3 text-sm" key={company.xeroTenantId}>
                <span>{company.name}</span>
                <span className="font-mono">{company.purchaserCode ?? 'None'}</span>
              </div>
            )
          ))}
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">No company is connected to Xero yet. Connect one under Invoices &gt; Settings.</p>
      )}
    </section>
  );
}

function CompanyCode({ company }: { company: PurchasingCompanyRow }) {
  const { setPurchaserCode } = usePurchasingCodeEdits();
  const [typed, setTyped] = useState(company.purchaserCode ?? '');
  const [error, setError] = useState<string | null>(null);
  const code = typed.trim() ? normalizePurchasingCode(typed) : null;
  const problem = typed.trim() ? purchasingCodeProblem(typed) : null;
  const changed = code !== company.purchaserCode;
  const id = `purchaser-${company.xeroTenantId}`;

  async function save(event: FormEvent) {
    event.preventDefault();
    if (problem || !changed || setPurchaserCode.isPending) return;
    setError(null);
    try {
      await setPurchaserCode.mutateAsync({ xeroTenantId: company.xeroTenantId, input: { purchaserCode: code } });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That could not be saved.');
    }
  }

  return (
    <form aria-label={`Purchaser code of ${company.name}`} className="flex flex-wrap items-end gap-3 p-4" onSubmit={(event) => void save(event)}>
      <div className="grid min-w-48 flex-1 gap-0.5">
        <span className="font-medium">{company.name}</span>
        <span className="text-muted-foreground text-xs">{company.trackingCategories.length ? `${company.trackingCategories.length} Xero tracking ${company.trackingCategories.length === 1 ? 'category' : 'categories'}` : 'No Xero tracking categories read yet'}</span>
      </div>
      <Field className="w-44">
        <FieldLabel htmlFor={id}>Purchaser code</FieldLabel>
        <Input autoCapitalize="characters" autoComplete="off" className="font-mono" id={id} maxLength={20} onChange={(event) => setTyped(event.target.value.toUpperCase())} placeholder="None" value={typed} />
      </Field>
      <Button disabled={Boolean(problem) || !changed || setPurchaserCode.isPending} type="submit" variant="outline">
        {setPurchaserCode.isPending ? <Spinner /> : null}
        {company.purchaserCode && !code ? 'Take away' : 'Save'}
      </Button>
      <p aria-live="polite" className="text-destructive basis-full text-sm empty:hidden">
        {problem ?? error ?? ''}
      </p>
    </form>
  );
}

// ── One code ──────────────────────────────────────────────────────────────

interface Draft {
  code: string;
  name: string;
  keepsStock: boolean;
  /** Each company's chosen option, as "category|option", or NONE. */
  xero: Record<string, string>;
}

const draftOf = (code?: PurchasingCodeRow): Draft => ({
  code: code?.code ?? '',
  name: code?.name ?? '',
  keepsStock: code?.keepsStock ?? true,
  xero: Object.fromEntries((code?.xero ?? []).map((match) => [match.xeroTenantId, optionValue(match)])),
});

/** What each company is matched to, as the request sends it. */
function matchesOf(draft: Draft): XeroOptionMatch[] {
  return Object.entries(draft.xero).flatMap(([xeroTenantId, value]) => {
    if (value === NONE) return [];
    const [trackingCategoryId, trackingOptionId] = value.split('|') as [string, string];
    return [{ xeroTenantId, trackingCategoryId, trackingOptionId }];
  });
}

function CodeFields({ kind, draft, set, companies, prefix }: { kind: PurchasingCodeKind; draft: Draft; set: (next: Partial<Draft>) => void; companies: readonly PurchasingCompanyRow[]; prefix: string }) {
  const codeProblem = draft.code.trim() ? purchasingCodeProblem(draft.code) : null;
  return (
    <>
      <Field>
        <FieldLabel htmlFor={`${prefix}-code`}>Code</FieldLabel>
        <Input autoCapitalize="characters" autoComplete="off" className="font-mono" id={`${prefix}-code`} maxLength={20} onChange={(event) => set({ code: event.target.value.toUpperCase() })} placeholder={kind === 'LINE_TYPE' ? 'LOT' : kind === 'UNIT' ? 'PK' : kind === 'REQUEST' ? 'RESTOCK' : 'MAINT'} value={draft.code} />
        {codeProblem ? <FieldError>{codeProblem}</FieldError> : <FieldDescription>Capitals, digits and dashes. Unique in this list.</FieldDescription>}
      </Field>
      <Field>
        <FieldLabel htmlFor={`${prefix}-name`}>Name</FieldLabel>
        <Input autoComplete="off" id={`${prefix}-name`} maxLength={120} onChange={(event) => set({ name: event.target.value })} placeholder={{ LINE_TYPE: 'Lot, bought as one batch', UNIT: 'pack', REQUEST: 'Restock the storeroom', DEPARTMENT: 'Maintenance', COST_CENTER: 'Operations' }[kind]} value={draft.name} />
      </Field>
      {kind === 'LINE_TYPE' ? (
        <Field className="flex items-center justify-between gap-3">
          <FieldLabel htmlFor={`${prefix}-stock`}>Keeps stock</FieldLabel>
          <Switch checked={draft.keepsStock} id={`${prefix}-stock`} onCheckedChange={(keepsStock) => set({ keepsStock })} />
        </Field>
      ) : null}
      {TRACKED_CODE_KINDS.includes(kind)
        ? companies.map((company) => {
            const id = `${prefix}-xero-${company.xeroTenantId}`;
            const value = draft.xero[company.xeroTenantId] ?? NONE;
            return (
              <Field key={company.xeroTenantId}>
                <FieldLabel htmlFor={id}>Xero tracking in {company.name}</FieldLabel>
                <Select onValueChange={(chosen) => set({ xero: { ...draft.xero, [company.xeroTenantId]: chosen } })} value={value}>
                  <SelectTrigger id={id}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Not matched</SelectItem>
                    {company.trackingCategories.flatMap((category) =>
                      category.options.map((option) => (
                        <SelectItem key={`${category.id}|${option.id}`} value={`${category.id}|${option.id}`}>
                          {category.name}: {option.name}
                        </SelectItem>
                      )),
                    )}
                  </SelectContent>
                </Select>
                <FieldDescription>{company.trackingCategories.length ? 'A bill coded with it reaches Xero with this option.' : 'This company has no tracking categories in Xero yet.'}</FieldDescription>
              </Field>
            );
          })
        : null}
    </>
  );
}

const ready = (draft: Draft) => !purchasingCodeProblem(draft.code) && draft.name.trim().length > 0;

function NewCode({ kind, companies }: { kind: PurchasingCodeKind; companies: readonly PurchasingCompanyRow[] }) {
  const { create } = usePurchasingCodeEdits();
  const [draft, setDraft] = useState<Draft>(draftOf());
  const [added, setAdded] = useState<string | null>(null);
  const singular = PURCHASING_CODE_KIND_LABEL[kind].replace(/s$/, '');

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready(draft) || create.isPending) return;
    const code = normalizePurchasingCode(draft.code);
    const matches = matchesOf(draft);
    const input: SavePurchasingCodeInput = {
      kind,
      code,
      name: draft.name.trim(),
      ...(kind === 'LINE_TYPE' ? { keepsStock: draft.keepsStock } : {}),
      ...(matches.length ? { xero: matches } : {}),
    };
    try {
      await create.mutateAsync(input);
      setAdded(code);
      setDraft(draftOf());
    } catch {
      // The mutation holds the API's message; it is shown below.
    }
  }

  return (
    <form aria-label={`New ${singular.toLowerCase()}`} className="bg-card grid gap-4 rounded-xl border p-4" onSubmit={(event) => void submit(event)}>
      <h2 className="text-base font-semibold">New {singular.toLowerCase()}</h2>
      <CodeFields
        companies={companies}
        draft={draft}
        kind={kind}
        prefix="new-purchasing-code"
        set={(next) => {
          setDraft((now) => ({ ...now, ...next }));
          setAdded(null);
        }}
      />
      {create.error ? (
        <Alert variant="destructive">
          <AlertDescription>{create.error.message}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={!ready(draft) || create.isPending} type="submit">
          {create.isPending ? <Spinner /> : null}
          Add {singular.toLowerCase()}
        </Button>
      </div>
      <p aria-live="polite" className="text-muted-foreground text-sm">
        {added ? `${added} is added.` : ''}
      </p>
    </form>
  );
}

function EditCode({ code, companies, onClose }: { code: PurchasingCodeRow; companies: readonly PurchasingCompanyRow[]; onClose: () => void }) {
  const { update } = usePurchasingCodeEdits();
  const [draft, setDraft] = useState<Draft>(draftOf(code));
  const [active, setActive] = useState(code.active);

  const typed = normalizePurchasingCode(draft.code);
  const before = matchesOf(draftOf(code));
  const after = matchesOf(draft);
  const input: SavePurchasingCodeInput = {};
  if (typed !== code.code) input.code = typed;
  if (draft.name.trim() !== code.name) input.name = draft.name.trim();
  if (code.kind === 'LINE_TYPE' && draft.keepsStock !== code.keepsStock) input.keepsStock = draft.keepsStock;
  if (active !== code.active) input.active = active;
  if (JSON.stringify(after) !== JSON.stringify(before)) input.xero = after;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready(draft) || !Object.keys(input).length || update.isPending) return;
    try {
      await update.mutateAsync({ codeId: code.id, input });
      onClose();
    } catch {
      // The mutation holds the API's message; it is shown below.
    }
  }

  return (
    <Dialog onOpenChange={(open) => (open ? undefined : onClose())} open>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit {code.code}</DialogTitle>
          <DialogDescription>
            {PURCHASING_CODE_KIND_LABEL[code.kind]}. {code.kind === 'LINE_TYPE' && code.used ? `${code.used} item codes are of this type.` : 'Switch it off rather than remove it, so a requisition that named it still reads.'}
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
          <CodeFields companies={companies} draft={draft} kind={code.kind} prefix="edit-purchasing-code" set={(next) => setDraft((now) => ({ ...now, ...next }))} />
          <Field className="flex items-center justify-between gap-3">
            <FieldLabel htmlFor="edit-purchasing-code-active">In use</FieldLabel>
            <Switch checked={active} id="edit-purchasing-code-active" onCheckedChange={setActive} />
          </Field>
          {update.error ? (
            <Alert variant="destructive">
              <AlertDescription>{update.error.message}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button onClick={onClose} type="button" variant="outline">
              Cancel
            </Button>
            <Button disabled={!ready(draft) || !Object.keys(input).length || update.isPending} type="submit">
              {update.isPending ? <Spinner /> : null}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
