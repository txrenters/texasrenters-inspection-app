'use client';

import {
  approverLimitSaying,
  companiesSaying,
  departmentsSaying,
  formatMoney,
  parseMoney,
  type PurchasingPeople,
  type PurchasingPersonRow,
  type PurchasingRoleColumn,
  type PurchasingRoleKey,
  type SavePurchasingPersonInput,
} from '@texasrenters/shared';
import { ChevronDownIcon, PlusIcon } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { FastTab } from '@/components/purchasing/nav-kit';
import { ErrorState } from '@/components/states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { usePurchasingPeople, usePurchasingPeopleEdits } from '@/lib/purchasing-queries';

/**
 * Purchasing Setup's "Roles and who holds them" (2026-11-21, part 5b), as the
 * approved board draws it: a person by person matrix of the eight purchasing
 * roles, an approver's own limit beside their tick, and the companies each
 * person acts for. Every change saves when it is made.
 *
 * A grey tick is a role whose permissions the person holds through another
 * role (the office's Admin, a system admin): shown, so nothing is hidden, and
 * changed on the Users page. Nobody changes their own row; a system admin's
 * row is changed nowhere.
 */
export function RolesSection({ enabled }: { enabled: boolean }) {
  const people = usePurchasingPeople(enabled);
  const edits = usePurchasingPeopleEdits();
  const error = edits.setRole.error ?? edits.savePerson.error ?? edits.addPerson.error;

  return (
    <FastTab action={<span className="text-muted-foreground text-xs">Who may do what</span>} title="Roles and who holds them">
      {people.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : people.isError || !people.data ? (
        <ErrorState error={people.error} retry={() => void people.refetch()} />
      ) : (
        <div className="grid gap-3">
          <p className="text-sm">
            Each purchasing role is a set of permissions on the console&rsquo;s Roles page. Tick to give a person a role; a person can be limited to some companies.
          </p>
          <div className="overflow-x-auto">
            <Table>
              {/* Static: the console's sticky header covers the first row inside a sideways scroll box. */}
              <TableHeader className="lg:static">
                <TableRow>
                  <TableHead>Person</TableHead>
                  {people.data.roles.map((role) => (
                    <TableHead className="text-center" key={role.key} title={`${role.roleName ?? 'Made the first time it is given'}: ${role.permissions.join(', ')}`}>
                      {role.label}
                    </TableHead>
                  ))}
                  <TableHead>Companies</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {people.data.people.map((person) => (
                  <PersonRow data={people.data!} key={person.id} person={person} />
                ))}
              </TableBody>
            </Table>
          </div>
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error.message}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <AddPerson candidates={people.data.candidates} />
            <Link className="text-sm font-medium underline-offset-4 hover:underline" href="/roles">
              Open the Roles page
            </Link>
            <span className="text-muted-foreground text-sm">Purchasing admin may change this tab; only a system admin may make somebody a Purchasing admin.</span>
          </div>
        </div>
      )}
    </FastTab>
  );
}

/** Why a box cannot be changed here, or null when it can. */
function lockedBecause(person: PurchasingPersonRow, role: PurchasingRoleColumn): string | null {
  if (person.systemAdmin) return 'A system admin holds everything.';
  if (person.you) return 'Nobody changes their own roles.';
  if (person.roles[role.key] === 'OTHER') return 'Held through another role: changed on the Users page.';
  if (!role.grantable) return role.key === 'PURCHASING_ADMIN' ? 'Only a system admin makes somebody a Purchasing admin.' : 'This role holds more than purchasing: given on the Users page.';
  return null;
}

function PersonRow({ person, data }: { person: PurchasingPersonRow; data: PurchasingPeople }) {
  const { setRole, savePerson } = usePurchasingPeopleEdits();
  const fixed = person.systemAdmin || person.you;
  const save = (patch: Partial<SavePurchasingPersonInput>) =>
    savePerson.mutate({
      personId: person.id,
      input: { companyTenantIds: person.companyTenantIds, departmentIds: person.departmentIds, approvesAnyAmount: person.approvesAnyAmount, approvalLimitCents: person.approvalLimitCents, ...patch },
    });
  return (
    <TableRow>
      <TableCell className="whitespace-nowrap">
        {person.name} <span className="text-muted-foreground text-xs">{person.code}</span>
        {person.you ? <span className="text-muted-foreground text-xs"> · you</span> : null}
      </TableCell>
      {data.roles.map((role) => {
        const hold = person.roles[role.key];
        const locked = lockedBecause(person, role);
        return (
          <TableCell className="text-center" key={role.key}>
            <span className="inline-flex items-center gap-1.5">
              <Checkbox
                aria-label={`${person.name}: ${role.label}`}
                checked={hold !== null}
                className={hold === 'OTHER' ? 'opacity-50' : undefined}
                disabled={Boolean(locked) || setRole.isPending}
                onCheckedChange={(on) => setRole.mutate({ personId: person.id, role: role.key as PurchasingRoleKey, held: on === true })}
                title={locked ?? undefined}
              />
              {role.key === 'APPROVER' && hold ? <ApproverLimit disabled={fixed} onSave={save} person={person} /> : null}
              {/* An approver approves the requisitions of the departments ticked here (2026-11-21). */}
              {role.key === 'APPROVER' && hold ? <Departments data={data} disabled={fixed} onSave={(departmentIds) => save({ departmentIds })} person={person} /> : null}
              {/* The purchasing manager's limit is the same one, for orders. */}
              {role.key === 'PURCHASING_MANAGER' && hold && !person.roles.APPROVER ? <ApproverLimit disabled={fixed} onSave={save} person={person} /> : null}
            </span>
          </TableCell>
        );
      })}
      <TableCell>
        <Companies data={data} disabled={fixed} onSave={(companyTenantIds) => save({ companyTenantIds })} person={person} />
      </TableCell>
    </TableRow>
  );
}

/** "any amount", "to $5,000.00", or "set a limit": opens to change it. */
function ApproverLimit({ person, disabled, onSave }: { person: PurchasingPersonRow; disabled: boolean; onSave: (patch: Partial<SavePurchasingPersonInput>) => void }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<'steps' | 'any' | 'limit'>(person.approvesAnyAmount ? 'any' : person.approvalLimitCents !== null ? 'limit' : 'steps');
  const [amount, setAmount] = useState(person.approvalLimitCents === null ? '' : (person.approvalLimitCents / 100).toFixed(2));
  const cents = parseMoney(amount);
  const invalid = kind === 'limit' && (cents === null || cents <= 0);
  const said = approverLimitSaying(person);
  if (disabled) return said ? <span className="text-xs">{said}</span> : null;
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <button aria-label={`${person.name}: approval limit`} className="text-xs underline-offset-4 hover:underline" type="button">
          {said || 'set a limit'}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="grid w-64 gap-2">
        <span className="text-sm font-medium">{person.name} approves</span>
        {(
          [
            ['steps', 'As the approval steps say'],
            ['any', 'Any amount'],
            ['limit', 'Up to an amount'],
          ] as const
        ).map(([value, label]) => (
          <Label className="flex items-center gap-2 font-normal" key={value}>
            <input checked={kind === value} name={`limit-${person.id}`} onChange={() => setKind(value)} type="radio" />
            {label}
          </Label>
        ))}
        {kind === 'limit' ? <Input aria-label="Approval limit, in dollars" inputMode="decimal" onChange={(event) => setAmount(event.target.value)} placeholder="5,000.00" value={amount} /> : null}
        <Button
          disabled={invalid}
          onClick={() => {
            onSave({ approvesAnyAmount: kind === 'any', approvalLimitCents: kind === 'limit' ? cents : null });
            setOpen(false);
          }}
          size="sm"
        >
          {kind === 'limit' && cents ? `Save, up to ${formatMoney(cents)}` : 'Save'}
        </Button>
      </PopoverContent>
    </Popover>
  );
}

/** The companies a person acts for: all, or the ones ticked. */
function Companies({ person, data, disabled, onSave }: { person: PurchasingPersonRow; data: PurchasingPeople; disabled: boolean; onSave: (tenantIds: string[]) => void }) {
  const said = companiesSaying(person.companyTenantIds, data.companies);
  if (disabled) return <span className="text-sm">{said}</span>;
  const toggle = (tenantId: string, on: boolean) => onSave(data.companies.map((company) => company.tenantId).filter((one) => (one === tenantId ? on : person.companyTenantIds.includes(one))));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button aria-label={`${person.name}: companies`} className="h-8 justify-between gap-1 font-normal" size="sm" variant="ghost">
          {said}
          <ChevronDownIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => onSave([])}>All companies</DropdownMenuItem>
        <DropdownMenuSeparator />
        {data.companies.map((company) => (
          <DropdownMenuCheckboxItem
            checked={person.companyTenantIds.includes(company.tenantId)}
            key={company.tenantId}
            onCheckedChange={(on) => toggle(company.tenantId, on === true)}
            onSelect={(event) => event.preventDefault()}
          >
            {company.purchaserCode ? `${company.purchaserCode} · ` : ''}
            {company.name}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The departments an approver approves (2026-11-21): all, or those ticked. */
function Departments({ person, data, disabled, onSave }: { person: PurchasingPersonRow; data: PurchasingPeople; disabled: boolean; onSave: (ids: string[]) => void }) {
  const said = departmentsSaying(person.departmentIds, data.departments ?? []);
  if (disabled) return <span className="text-muted-foreground text-xs">{said}</span>;
  const toggle = (id: string, on: boolean) => onSave((data.departments ?? []).map((department) => department.id).filter((one) => (one === id ? on : person.departmentIds.includes(one))));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button aria-label={`${person.name}: departments approved`} className="h-7 gap-1 px-1.5 text-xs font-normal" size="sm" title="The departments whose requisitions they approve" variant="ghost">
          {said === 'All' ? 'All departments' : said}
          <ChevronDownIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onSelect={() => onSave([])}>All departments</DropdownMenuItem>
        <DropdownMenuSeparator />
        {(data.departments ?? []).map((department) => (
          <DropdownMenuCheckboxItem
            checked={person.departmentIds.includes(department.id)}
            key={department.id}
            onCheckedChange={(on) => toggle(department.id, on === true)}
            onSelect={(event) => event.preventDefault()}
          >
            {department.code} · {department.name}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Somebody of the office not on the list yet. */
function AddPerson({ candidates }: { candidates: PurchasingPeople['candidates'] }) {
  const { addPerson } = usePurchasingPeopleEdits();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button disabled={!candidates.length || addPerson.isPending} size="sm" variant="outline">
          <PlusIcon /> Add a person
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
        {candidates.map((candidate) => (
          <DropdownMenuItem key={candidate.id} onSelect={() => addPerson.mutate({ userProfileId: candidate.id })}>
            {candidate.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
