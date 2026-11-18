'use client';

import { HammerIcon } from 'lucide-react';

import { PageHeader } from '@/components/page-header';
import { EmptyState } from '@/components/states';

/**
 * The work orders handed over by the maintenance app for the in-house crews.
 *
 * The hand-off itself is live (POST /gateway/work-orders files each one as a
 * MAINTENANCE or PEST_CONTROL visit, see docs/integrations/TX_MAINTENANCE_WORK_ORDERS.md);
 * this is the page the office opens them from. Until the list is built, it
 * points at where those visits already show.
 */
export default function WorkOrdersPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Work orders"
        description="Repair and pest-control work orders handed over by the maintenance app for the in-house crews."
      />
      <EmptyState
        icon={HammerIcon}
        title="The work-order list is on its way"
        description="Work orders already arrive from the maintenance app and are filed as Maintenance and Pest control visits under Inspections. This page will list them by work order."
      />
    </div>
  );
}
