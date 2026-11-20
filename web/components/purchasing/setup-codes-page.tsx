'use client';

import {
  FACT_BOXES,
  KEEPER_ROLES,
  PAGE_FIELD_KEYS,
  PURCHASING_ROLES,
  REQUISITION_FIELDS,
  audienceSaying,
  codeList,
  type CodeKeepers,
  type FactBoxSetting,
  type KeeperRole,
  type PurchasingRoleKey,
  type PurchasingSetup,
  type RequisitionFieldKey,
  type RequisitionPageLayout,
} from '@texasrenters/shared';
import { ArrowDownIcon, ArrowUpIcon, ChevronDownIcon, GripVerticalIcon } from 'lucide-react';
import { useState } from 'react';

import { FastTab } from '@/components/purchasing/nav-kit';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { usePurchasingSetupEdits } from '@/lib/purchasing-queries';

/**
 * Purchasing Setup's "Codes, and who makes them" and "The requisition page"
 * (2026-11-21, part 5c), as the approved board draws them. Who keeps a list is
 * enforced everywhere in the console; a code list's "On the requisition" is
 * the same setting as the page's Required, so the two never disagree. Every
 * change saves when it is made.
 */

const ROLE_LABEL = Object.fromEntries(PURCHASING_ROLES.map((role) => [role.key, role.label])) as Record<PurchasingRoleKey, string>;
const FIELD_LABEL = Object.fromEntries(REQUISITION_FIELDS.map((field) => [field.key, field.label])) as Record<RequisitionFieldKey, string>;

function Problem({ error }: { error: Error | null }) {
  return error ? (
    <Alert variant="destructive">
      <AlertDescription>{error.message}</AlertDescription>
    </Alert>
  ) : null;
}

// ── Codes, and who makes them ────────────────────────────────────────────────

export function CodesSection({ setup }: { setup: PurchasingSetup }) {
  const { codes: saveKeepers, page: savePage } = usePurchasingSetupEdits();
  const keepers = Object.fromEntries(setup.codes.map((one) => [one.list, one.keeper])) as CodeKeepers;
  const setRequired = (field: RequisitionFieldKey, required: boolean) =>
    savePage.mutate({ ...setup.page, fields: { ...setup.page.fields, [field]: { shown: required || setup.page.fields[field].shown, required } } });

  return (
    <FastTab title="Codes, and who makes them">
      <div className="grid gap-3">
        <div className="overflow-x-auto">
          <Table>
            {/* Static: the console's sticky header covers the first row inside a sideways scroll box. */}
            <TableHeader className="lg:static">
              <TableRow>
                <TableHead>Code list</TableHead>
                <TableHead>Who may make and change</TableHead>
                <TableHead>On the requisition</TableHead>
                <TableHead className="text-right">In use</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {setup.codes.map((one) => {
                const list = codeList(one.list);
                const field = list.field as RequisitionFieldKey | null;
                return (
                  <TableRow key={one.list}>
                    <TableCell>{list.label}</TableCell>
                    <TableCell>
                      <Select onValueChange={(role) => saveKeepers.mutate({ keepers: { ...keepers, [one.list]: role as KeeperRole } })} value={one.keeper}>
                        <SelectTrigger aria-label={`${list.label}: who may make and change`} className="w-48">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {KEEPER_ROLES.map((role) => (
                            <SelectItem key={role} value={role}>
                              {ROLE_LABEL[role]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      {field ? (
                        <Select onValueChange={(value) => setRequired(field, value === 'required')} value={setup.page.fields[field].required ? 'required' : 'optional'}>
                          <SelectTrigger aria-label={`${list.label}: on the requisition`} className="w-52">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="required">{field === 'LINE_DEPARTMENT' ? 'Required on every line' : 'Required'}</SelectItem>
                            <SelectItem value="optional">Optional</SelectItem>
                          </SelectContent>
                        </Select>
                      ) : (
                        <span className="text-muted-foreground text-sm">{list.fixed}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{one.inUse}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        <p className="text-muted-foreground text-sm">
          Department and cost center codes are made here. Each can be matched to a Xero tracking option, so a bill reaches Xero already coded. Item codes, categories, places and vendors are
          kept on the Inventory page, which also needs &ldquo;View inventory&rdquo;.
        </p>
        <Problem error={saveKeepers.error ?? savePage.error} />
      </div>
    </FastTab>
  );
}

// ── The requisition page ────────────────────────────────────────────────────

export function PageSection({ page }: { page: RequisitionPageLayout }) {
  const { page: save } = usePurchasingSetupEdits();
  const [dragged, setDragged] = useState<number | null>(null);
  const saveFields = (field: RequisitionFieldKey, patch: Partial<RequisitionPageLayout['fields'][RequisitionFieldKey]>) => {
    const next = { ...page.fields[field], ...patch };
    // A field hidden is never required.
    if (!next.shown) next.required = false;
    save.mutate({ ...page, fields: { ...page.fields, [field]: next } });
  };
  const saveBoxes = (factBoxes: FactBoxSetting[]) => save.mutate({ ...page, factBoxes });
  const move = (from: number, to: number) => {
    if (from === to || to < 0 || to >= page.factBoxes.length) return;
    const boxes = [...page.factBoxes];
    const [box] = boxes.splice(from, 1);
    boxes.splice(to, 0, box!);
    saveBoxes(boxes);
  };
  const changeBox = (index: number, patch: Partial<FactBoxSetting>) => saveBoxes(page.factBoxes.map((box, at) => (at === index ? { ...box, ...patch } : box)));

  return (
    <FastTab title="The requisition page">
      <div className="grid gap-6 xl:grid-cols-2">
        <section aria-labelledby="page-fields" className="grid content-start gap-2">
          <h3 className="text-sm font-semibold" id="page-fields">
            Fields
          </h3>
          <Table>
            <TableHeader className="lg:static">
              <TableRow>
                <TableHead>Field</TableHead>
                <TableHead>Shown</TableHead>
                <TableHead>Required</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {PAGE_FIELD_KEYS.map((field) => (
                <TableRow key={field}>
                  <TableCell>{FIELD_LABEL[field]}</TableCell>
                  <TableCell>
                    <Switch aria-label={`${FIELD_LABEL[field]}: shown`} checked={page.fields[field].shown} onCheckedChange={(shown) => saveFields(field, { shown })} />
                  </TableCell>
                  <TableCell>
                    <Switch
                      aria-label={`${FIELD_LABEL[field]}: required`}
                      checked={page.fields[field].required}
                      disabled={!page.fields[field].shown}
                      onCheckedChange={(required) => saveFields(field, { required })}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>

        <section aria-labelledby="page-factboxes" className="grid content-start gap-2">
          <h3 className="text-sm font-semibold" id="page-factboxes">
            FactBoxes, in this order
          </h3>
          <Table>
            <TableHeader className="lg:static">
              <TableRow>
                <TableHead className="w-16">
                  <span className="sr-only">Order</span>
                </TableHead>
                <TableHead>FactBox</TableHead>
                <TableHead>Shown</TableHead>
                <TableHead>Who sees it</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.factBoxes.map((box, index) => {
                const label = FACT_BOXES.find((one) => one.key === box.key)!.label;
                return (
                  <TableRow
                    className={dragged === index ? 'opacity-50' : undefined}
                    draggable
                    key={box.key}
                    onDragEnd={() => setDragged(null)}
                    onDragOver={(event) => event.preventDefault()}
                    onDragStart={() => setDragged(index)}
                    onDrop={() => {
                      if (dragged !== null) move(dragged, index);
                      setDragged(null);
                    }}
                  >
                    <TableCell>
                      <span className="text-muted-foreground inline-flex items-center gap-0.5">
                        <GripVerticalIcon aria-hidden className="size-4 cursor-grab" />
                        <button aria-label={`Move ${label} up`} className="hover:text-foreground disabled:opacity-30" disabled={index === 0} onClick={() => move(index, index - 1)} type="button">
                          <ArrowUpIcon className="size-3.5" />
                        </button>
                        <button
                          aria-label={`Move ${label} down`}
                          className="hover:text-foreground disabled:opacity-30"
                          disabled={index === page.factBoxes.length - 1}
                          onClick={() => move(index, index + 1)}
                          type="button"
                        >
                          <ArrowDownIcon className="size-3.5" />
                        </button>
                      </span>
                    </TableCell>
                    <TableCell>{label}</TableCell>
                    <TableCell>
                      <Switch aria-label={`${label}: shown`} checked={box.shown} onCheckedChange={(shown) => changeBox(index, { shown })} />
                    </TableCell>
                    <TableCell>
                      <Audience audience={box.audience} label={label} onChange={(audience) => changeBox(index, { audience })} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <p className="text-muted-foreground text-sm">Drag to reorder, or use the arrows. Applies to everybody&rsquo;s page.</p>
        </section>
      </div>
      <Problem error={save.error} />
    </FastTab>
  );
}

/** Everybody, or the roles ticked. */
function Audience({ audience, label, onChange }: { audience: PurchasingRoleKey[]; label: string; onChange: (audience: PurchasingRoleKey[]) => void }) {
  const toggle = (role: PurchasingRoleKey, on: boolean) => onChange(PURCHASING_ROLES.map((one) => one.key).filter((key) => (key === role ? on : audience.includes(key))));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button aria-label={`${label}: who sees it`} className="h-8 w-full justify-between font-normal" size="sm" variant="outline">
          <span className="truncate">{audienceSaying(audience, ROLE_LABEL)}</span>
          <ChevronDownIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onSelect={() => onChange([])}>Everybody</DropdownMenuItem>
        <DropdownMenuSeparator />
        {PURCHASING_ROLES.map((role) => (
          <DropdownMenuCheckboxItem checked={audience.includes(role.key)} key={role.key} onCheckedChange={(on) => toggle(role.key, on === true)} onSelect={(event) => event.preventDefault()}>
            {role.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
