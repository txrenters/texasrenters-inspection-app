'use client';

import type { RequisitionChoices, SaveRequisitionInput } from '@texasrenters/shared';
import { BoxesIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { PurchasingTabs } from '@/components/purchasing/purchasing-tabs';
import { EmptyState, ErrorState, PageSkeleton } from '@/components/states';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';
import { usePurchasingEdits, useRequisitionChoices } from '@/lib/purchasing-queries';

/**
 * New purchase requisition. As in NAV (the office's choice, 2026-11-21), New
 * makes the draft at once, so its PR number shows from the start; every field
 * is blank. One left empty stays a draft until somebody deletes it.
 *
 * From the Reorder list ("?items=<item>:<quantity>,..."), the draft starts with
 * the items ticked, for the company of the first: what one usually costs, from
 * its usual vendor.
 */
export default function NewRequisitionPage() {
  const router = useRouter();
  const asked = useSearchParams().get('items') ?? '';
  // The items need the choices; a blank one needs nothing.
  const choices = useRequisitionChoices(Boolean(asked));
  const { create } = usePurchasingEdits();
  // Made once, though React draws the page twice in development.
  const making = useRef(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (making.current || (asked && !choices.data)) return;
    making.current = true;
    void create
      .mutateAsync(draftFor(asked, choices.data))
      // Replaced, so Back goes to the list rather than making another.
      .then((made) => router.replace(`/purchasing/requisitions/${made.id}`))
      .catch(() => undefined);
    // Made once per attempt, once the choices are in hand.
  }, [attempt, asked, choices.data]);

  const failed = create.error ?? (asked ? choices.error : null);
  // Codes come first (the office, 2026-11-24): said as what to do next, not as something that broke.
  if (failed instanceof ApiError && failed.code === 'REQUISITION_NEEDS_ITEM_CODES')
    return (
      <>
        <PurchasingTabs current="requisitions" />
        <EmptyState description="A purchase requisition is made from item codes. Whoever keeps them adds the items first; then a requisition can be started." icon={BoxesIcon} title="There are no item codes yet">
          <Button asChild>
            <Link href="/inventory?tab=codes">Open Item codes</Link>
          </Button>
        </EmptyState>
      </>
    );
  if (failed)
    return (
      <>
        <PurchasingTabs current="requisitions" />
        <ErrorState
          error={failed}
          retry={() => {
            create.reset();
            if (choices.isError) void choices.refetch();
            making.current = false;
            setAttempt((n) => n + 1);
          }}
        />
      </>
    );
  return <PageSkeleton />;
}

/** A blank draft, or the Reorder list's items for the first one's company. */
function draftFor(asked: string, choices: RequisitionChoices | undefined): SaveRequisitionInput {
  const wanted = asked
    .split(',')
    .map((pair) => pair.split(':'))
    .flatMap(([itemId, quantity]) => (itemId && /^\d{1,6}$/.test(quantity ?? '') && Number(quantity) > 0 ? [{ itemId, quantity: Number(quantity) }] : []));
  const picked = wanted.flatMap(({ itemId, quantity }) => (choices?.items ?? []).filter((item) => item.id === itemId).map((item) => ({ item, quantity })));
  const company = picked[0]?.item.companyTenantId ?? null;
  return {
    xeroTenantId: company,
    neededBy: null,
    deliverToPlaceId: null,
    requestCodeId: null,
    costCenterId: null,
    documentDate: null,
    reason: '',
    // Another company's items would be refused: a requisition is for one company.
    lines: picked
      .filter(({ item }) => item.companyTenantId === company)
      .map(({ item, quantity }) => ({ itemId: item.id, quantity, estimatedUnitCostCents: item.priceCents ?? item.averageCostCents ?? 0, vendorId: item.usualVendorId ?? null })),
    quotes: [],
  };
}
