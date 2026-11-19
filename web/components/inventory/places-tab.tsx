'use client';

import { normalizePurchasingCode, purchasingCodeProblem, suggestedPlaceCode, STOCK_PLACE_KIND_LABEL, type SaveStockPlaceInput, type StockPlaceKind, type StockPlaceRow } from '@texasrenters/shared';
import { WarehouseIcon } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import { DataTable, DataTableSkeleton, type Column } from '@/components/data-table';
import { PlaceDialog } from '@/components/inventory/inventory-dialogs';
import { InUseBadge } from '@/components/inventory/stock-status';
import { EmptyState, ErrorState } from '@/components/states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { formatCount } from '@/lib/format';
import { useInventoryEdits, useStockPlaces } from '@/lib/inventory-queries';

/**
 * Places (2026-11-19, rebuilt to the approved drawing): the storeroom and each
 * truck. A delivery is received into a storeroom; the office moves stock from
 * there to a truck; a technician takes from a truck on a job. A truck with a
 * technician named on it is theirs alone on the phone; one with nobody named
 * may be used by any technician.
 *
 * A place keeps its kind once made, and cannot be switched off while it holds
 * stock: the server says both, and its sentence is shown. One read when the
 * tab opens; nothing here calls anything billed.
 */

/** Radix's Select has no empty value: this stands for "none chosen". */
const NONE = 'none';

const COLUMNS: Array<Column<StockPlaceRow>> = [
  { key: 'name', header: 'Place', primary: true, cell: (row) => <span className="font-medium">{row.name}</span> },
  { key: 'code', header: 'Location code', className: 'whitespace-nowrap', cell: (row) => <span className="font-mono font-semibold">{row.code}</span> },
  { key: 'kind', header: 'Kind', cell: (row) => STOCK_PLACE_KIND_LABEL[row.kind] },
  {
    key: 'technician',
    header: 'Technician',
    hideBelow: 'sm',
    cell: (row) => row.technicianName ?? <span className="text-muted-foreground text-xs">{row.kind === 'VAN' ? 'Anybody' : 'None'}</span>,
  },
  { key: 'held', header: 'Items held', numeric: true, hideBelow: 'sm', cell: (row) => formatCount(row.itemsHeld) },
  { key: 'status', header: 'Status', cell: (row) => <InUseBadge active={row.active} /> },
];

export function PlacesTab({ enabled, canManage }: { enabled: boolean; canManage: boolean }) {
  const places = useStockPlaces(enabled);
  const { updatePlace } = useInventoryEdits();
  const [editing, setEditing] = useState<StockPlaceRow | null>(null);

  if (places.isError) return <ErrorState error={places.error} retry={() => void places.refetch()} />;
  if (!places.data) return <DataTableSkeleton columns={COLUMNS} label="Loading places" rows={3} />;
  const { places: rows, technicians } = places.data;

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <section aria-labelledby="places-heading" className="grid gap-3">
        <h2 className="text-base font-semibold" id="places-heading">
          Places
        </h2>
        {rows.length ? (
          <DataTable
            actions={
              canManage
                ? (row) => (
                    <Button aria-label={`Edit ${row.name}`} onClick={() => setEditing(row)} size="sm" variant="outline">
                      Edit
                    </Button>
                  )
                : undefined
            }
            columns={COLUMNS}
            label="Places stock is kept"
            rowKey={(row) => row.id}
            rows={rows}
          />
        ) : (
          <EmptyState
            description={canManage ? 'Add the storeroom first, then a place for each truck that carries stock.' : 'No place has been added yet.'}
            icon={WarehouseIcon}
            title="No places yet"
          />
        )}
        <p className="text-muted-foreground text-xs">A place cannot be switched off while it still holds stock. Move the stock out first.</p>
        <div className="bg-muted/40 grid gap-1.5 rounded-xl border p-4 text-sm">
          <h3 className="font-semibold">How stock gets to a truck</h3>
          <ol className="text-muted-foreground grid list-decimal gap-1 pl-5">
            <li>A purchase order is delivered and received into a storeroom.</li>
            <li>Somebody in the office moves stock from the storeroom to a truck, on the Withdrawals tab.</li>
            <li>On the phone, a technician takes from their own truck for a job, or from a truck with nobody named on it.</li>
          </ol>
        </div>
      </section>

      {canManage ? <NewPlace technicians={technicians} /> : null}
      {editing ? (
        <PlaceDialog
          error={updatePlace.error}
          onClose={() => {
            setEditing(null);
            updatePlace.reset();
          }}
          onSave={(input) => updatePlace.mutateAsync({ placeId: editing.id, input })}
          pending={updatePlace.isPending}
          place={editing}
          technicians={technicians}
        />
      ) : null}
    </div>
  );
}

function NewPlace({ technicians }: { technicians: readonly { id: string; name: string }[] }) {
  const { createPlace } = useInventoryEdits();
  const [name, setName] = useState('');
  /** Typed over the suggestion; empty, the console makes one from the name. */
  const [code, setCode] = useState('');
  const [kind, setKind] = useState<StockPlaceKind>('VAN');
  const [technician, setTechnician] = useState(NONE);
  const [added, setAdded] = useState<string | null>(null);

  const clear = () => {
    setName('');
    setCode('');
    setTechnician(NONE);
  };

  const suggestion = name.trim() ? suggestedPlaceCode(name) : '';
  const codeProblem = code.trim() ? purchasingCodeProblem(code) : null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || codeProblem || createPlace.isPending) return;
    const input: SaveStockPlaceInput = { name: trimmed, kind, ...(code.trim() ? { code: normalizePurchasingCode(code) } : {}), ...(kind === 'VAN' && technician !== NONE ? { technicianId: technician } : {}) };
    try {
      await createPlace.mutateAsync(input);
      setAdded(trimmed);
      clear();
    } catch {
      // The mutation holds the API's message; it is shown below.
    }
  }

  return (
    <form aria-label="New place" className="bg-card grid gap-4 rounded-xl border p-4" onSubmit={(event) => void submit(event)}>
      <h2 className="text-base font-semibold">New place</h2>
      <Field>
        <FieldLabel htmlFor="new-place-name">Name</FieldLabel>
        <Input
          autoComplete="off"
          id="new-place-name"
          maxLength={80}
          onChange={(event) => {
            setName(event.target.value);
            setAdded(null);
          }}
          placeholder="Truck 1"
          value={name}
        />
        <FieldDescription>What people call it: Storeroom, Truck 1.</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="new-place-code">Location code</FieldLabel>
        <Input
          autoCapitalize="characters"
          autoComplete="off"
          className="font-mono"
          id="new-place-code"
          maxLength={20}
          onChange={(event) => {
            setCode(event.target.value.toUpperCase());
            setAdded(null);
          }}
          placeholder={suggestion || 'STORE'}
          value={code}
        />
        <FieldDescription>{codeProblem ?? (suggestion ? `Left empty, it is ${suggestion}. A requisition and an order name the place by it.` : 'A requisition and an order name the place by it: STORE, TRK-01.')}</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="new-place-kind">Kind</FieldLabel>
        <Select onValueChange={(value) => setKind(value as StockPlaceKind)} value={kind}>
          <SelectTrigger id="new-place-kind">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="VAN">{STOCK_PLACE_KIND_LABEL.VAN}</SelectItem>
            <SelectItem value="STOCKROOM">{STOCK_PLACE_KIND_LABEL.STOCKROOM}</SelectItem>
          </SelectContent>
        </Select>
        <FieldDescription>A storeroom is where deliveries are received. A truck is what a technician takes from. A place keeps its kind.</FieldDescription>
      </Field>
      {kind === 'VAN' ? (
        <Field>
          <FieldLabel htmlFor="new-place-technician">
            Technician <span className="text-muted-foreground font-normal">(optional)</span>
          </FieldLabel>
          <Select onValueChange={setTechnician} value={technician}>
            <SelectTrigger id="new-place-technician">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Nobody: any technician may use it</SelectItem>
              {technicians.map((person) => (
                <SelectItem key={person.id} value={person.id}>
                  {person.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldDescription>Named: only that technician takes from it on the phone. Nobody named: any technician can.</FieldDescription>
        </Field>
      ) : null}
      {createPlace.error ? (
        <Alert variant="destructive">
          <AlertDescription>{createPlace.error.message}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={!name.trim() || Boolean(codeProblem) || createPlace.isPending} type="submit">
          {createPlace.isPending ? <Spinner /> : null}
          Add place
        </Button>
        <Button
          onClick={() => {
            clear();
            setAdded(null);
            createPlace.reset();
          }}
          type="button"
          variant="outline"
        >
          Clear
        </Button>
      </div>
      <p aria-live="polite" className="text-muted-foreground text-sm">
        {added && !name ? `${added} is added.` : ''}
      </p>
    </form>
  );
}
