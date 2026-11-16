'use client';

import { REVENUE_COLUMNS, REVENUE_COLUMN_LABEL, type RevenueColumn } from '@texasrenters/shared';
import { useState } from 'react';
import { toast } from 'sonner';

import { ErrorState, PageSkeleton } from '@/components/states';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useRevenueLogEdits, useRevenueProducts } from '@/lib/actual-vs-budget-queries';

// ── Which column a product's lines go in ────────────────────────────────────

export function MoneyColumnsDialog({ onClose }: { onClose: () => void }) {
  const products = useRevenueProducts(true);
  const edits = useRevenueLogEdits();
  const [pending, setPending] = useState<string | null>(null);
  const change = (productId: string, column: RevenueColumn) => {
    setPending(productId);
    edits.saveProductColumn.mutate(
      { productId, column },
      {
        onError: (error) => toast.error('The column was not changed', { description: error.message }),
        onSettled: () => setPending(null),
      },
    );
  };
  return (
    <Dialog onOpenChange={(open) => (open ? null : onClose())} open>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Money columns</DialogTitle>
          <DialogDescription>Where each product&apos;s invoice lines go. Unset is Labor Hours Income.</DialogDescription>
        </DialogHeader>
        {products.isPending ? (
          <PageSkeleton cards={0} />
        ) : products.isError ? (
          <ErrorState error={products.error} retry={() => void products.refetch()} />
        ) : (
          <ul className="divide-y">
            {products.data.products.map((product) => (
              <li className="flex items-center justify-between gap-3 py-2" key={product.productId}>
                <span className="min-w-0 text-sm">{product.name}</span>
                <Select disabled={pending === product.productId} onValueChange={(value) => change(product.productId, value as RevenueColumn)} value={product.column}>
                  <SelectTrigger aria-label={`Column for ${product.name}`} className="w-48 shrink-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {REVENUE_COLUMNS.map((column) => (
                      <SelectItem key={column} value={column}>
                        {REVENUE_COLUMN_LABEL[column]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
