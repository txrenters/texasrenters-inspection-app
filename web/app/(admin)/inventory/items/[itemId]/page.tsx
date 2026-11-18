'use client';

import { formatMoney, type StockMovementRow } from '@texasrenters/shared';
import { BoxIcon } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';

import { DataTable, type Column } from '@/components/data-table';
import { ItemDialog, OpeningBalanceDialog, ReverseMovementDialog } from '@/components/inventory/inventory-dialogs';
import { StockStatusBadge } from '@/components/inventory/stock-status';
import { PageHeader } from '@/components/page-header';
import { AsideCard, FactTable } from '@/components/record/record-kit';
import { EmptyState, ErrorState, PageSkeleton } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { usePermissions } from '@/lib/auth';
import { EMPTY, formatCount, formatDay } from '@/lib/format';
import { useInventoryEdits, useStock, useStockItem } from '@/lib/inventory-queries';

/**
 * One item (2026-11-19, phase 1): where it is, what it cost, and its ledger --
 * every movement, newest first, each with the on hand it left. A movement has
 * no edit: a wrong one is reversed by a second line, and the first stays as it
 * was written.
 */

const KIND_LABEL: Record<StockMovementRow['kind'], string> = { OPENING_BALANCE: 'Opening balance', REVERSAL: 'Reversal' };

const MOVEMENT_COLUMNS: Array<Column<StockMovementRow>> = [
  { key: 'day', header: 'Day', cell: (row) => formatDay(row.day), className: 'whitespace-nowrap' },
  {
    key: 'what',
    header: 'What happened',
    primary: true,
    cell: (row) => (
      <span className="grid gap-0.5">
        <span className="flex flex-wrap items-center gap-2 font-medium">
          {KIND_LABEL[row.kind]}
          {row.reversedById ? <Badge variant="outline">Reversed</Badge> : null}
        </span>
        {row.note ? <span className="text-muted-foreground text-xs">{row.note}</span> : null}
      </span>
    ),
  },
  { key: 'place', header: 'Place', cell: (row) => row.placeName },
  { key: 'in', header: 'In', numeric: true, cell: (row) => (row.quantity > 0 ? formatCount(row.quantity) : '') },
  { key: 'out', header: 'Out', numeric: true, cell: (row) => (row.quantity < 0 ? formatCount(-row.quantity) : '') },
  { key: 'cost', header: 'Cost of one', numeric: true, hideBelow: 'lg', cell: (row) => formatMoney(row.unitCostCents) },
  { key: 'after', header: 'On hand after', numeric: true, cell: (row) => formatCount(row.onHandAfter) },
  { key: 'by', header: 'By', hideBelow: 'md', cell: (row) => row.by },
];

export default function StockItemPage() {
  const { itemId } = useParams<{ itemId: string }>();
  const canManage = usePermissions().has('inventory:manage');
  const detail = useStockItem(itemId);
  const [editing, setEditing] = useState(false);
  const [opening, setOpening] = useState(false);
  const [reversing, setReversing] = useState<StockMovementRow | null>(null);
  // The companies, vendors and places the forms choose from: the Stock tab's read, usually still in hand.
  const stock = useStock();
  const edits = useInventoryEdits();

  if (detail.isLoading) return <PageSkeleton />;
  if (detail.isError || !detail.data) return <ErrorState error={detail.error} retry={() => void detail.refetch()} />;

  const { item, levels, movements, movementsTotal, averageCostCents } = detail.data;
  const choices = stock.data;

  return (
    <>
      <PageHeader
        actions={
          canManage ? (
            <>
              <Button disabled={!choices} onClick={() => setEditing(true)} variant="outline">
                Edit item
              </Button>
              <Button disabled={!choices || !item.active} onClick={() => setOpening(true)}>
                Enter opening balance
              </Button>
            </>
          ) : undefined
        }
        badges={<StockStatusBadge item={item} />}
        description={
          <>
            <Link className="underline-offset-4 hover:underline" href="/inventory">
              Inventory
            </Link>
            {` · ${item.code} · ${item.company?.name ?? 'No company yet'} · counted in ${item.unit}`}
          </>
        }
        prominent
        record={{ icon: BoxIcon, tone: 'text-info', label: 'Stock item' }}
        title={item.name}
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <AsideCard title={`On hand: ${formatCount(item.onHand)}`}>
          {levels.length ? (
            <FactTable facts={levels.map((level) => ({ label: level.placeName, value: formatCount(level.quantity) }))} label="On hand by place" />
          ) : (
            <p className="text-muted-foreground">None anywhere yet.</p>
          )}
        </AsideCard>
        <AsideCard title="Reordering">
          <FactTable
            facts={[
              { label: 'Reorder at or below', value: item.reorderLevel ? formatCount(item.reorderLevel) : EMPTY },
              { label: 'Usual order quantity', value: item.reorderQuantity ? formatCount(item.reorderQuantity) : EMPTY },
              { label: 'Usual vendor', value: item.usualVendor?.name ?? EMPTY },
              { label: 'Category', value: item.category?.name ?? EMPTY },
            ]}
            label="Reordering"
          />
        </AsideCard>
        <AsideCard title="Cost">
          <FactTable
            facts={[
              { label: 'Average cost of one', value: averageCostCents === null ? EMPTY : formatMoney(averageCostCents) },
              { label: 'Value on hand', value: formatMoney(item.valueCents) },
            ]}
            label="Cost"
          />
        </AsideCard>
      </div>

      <section className="mt-6 grid gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-heading text-base font-bold">Movements</h2>
          <p className="text-muted-foreground text-xs">
            {movementsTotal > movements.length ? `The newest ${formatCount(movements.length)} of ${formatCount(movementsTotal)}. ` : ''}
            A line is never edited. A mistake is put right by reversing it.
          </p>
        </div>
        {movements.length ? (
          <DataTable
            actions={
              canManage
                ? (row) =>
                    row.kind !== 'REVERSAL' && !row.reversedById ? (
                      <Button aria-label={`Reverse the ${KIND_LABEL[row.kind].toLowerCase()} of ${formatDay(row.day)} in ${row.placeName}`} onClick={() => setReversing(row)} size="sm" variant="outline">
                        Reverse
                      </Button>
                    ) : null
                : undefined
            }
            columns={MOVEMENT_COLUMNS}
            label={`Movements of ${item.name}`}
            rowKey={(row) => row.id}
            rows={movements}
          />
        ) : (
          <EmptyState
            description={canManage ? 'Enter what is on the shelf today as the opening balance, once for each place it is kept.' : 'This item has not moved yet.'}
            icon={BoxIcon}
            title="No movements yet"
          />
        )}
      </section>

      {editing && choices ? (
        <ItemDialog
          categories={choices.categories}
          companies={choices.companies}
          companyFixed={movementsTotal > 0}
          error={edits.updateItem.error}
          item={item}
          onClose={() => {
            setEditing(false);
            edits.updateItem.reset();
          }}
          onSave={(input) => edits.updateItem.mutateAsync({ itemId, input })}
          pending={edits.updateItem.isPending}
          vendors={choices.vendors}
        />
      ) : null}
      {opening && choices ? (
        <OpeningBalanceDialog
          error={edits.enterOpeningBalance.error}
          item={item}
          onClose={() => {
            setOpening(false);
            edits.enterOpeningBalance.reset();
          }}
          onSave={(input) => edits.enterOpeningBalance.mutateAsync({ itemId, input })}
          pending={edits.enterOpeningBalance.isPending}
          places={choices.places}
        />
      ) : null}
      {reversing ? (
        <ReverseMovementDialog
          error={edits.reverseMovement.error}
          item={item}
          movement={reversing}
          onClose={() => {
            setReversing(null);
            edits.reverseMovement.reset();
          }}
          onSave={(reason) => edits.reverseMovement.mutateAsync({ movementId: reversing.id, input: { reason } })}
          pending={edits.reverseMovement.isPending}
        />
      ) : null}
    </>
  );
}
