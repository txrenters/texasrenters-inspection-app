'use client';

import { KEEPER_PERMISSIONS } from '@texasrenters/shared';
import Link from 'next/link';

import { usePermissions } from '@/lib/auth';
import { cn } from '@/lib/utils';

/**
 * Purchasing's tabs across the top of a requisition, as the canvas draws them
 * (2026-11-20): Requisitions marked, Orders and Codes a click away. Codes only
 * for whoever may keep them.
 */
export function PurchasingTabs({ current }: { current: 'requisitions' | 'orders' | 'approvals' | 'setup' }) {
  const { has, hasAny } = usePermissions();
  // NAV's names (the office, 2026-11-21); the codes are in Setup, read by anybody in purchasing.
  const tabs = [
    { key: 'requisitions', label: 'Purchase Requisitions' },
    { key: 'orders', label: 'Purchase Orders' },
    ...(hasAny('purchasing:approve', 'purchasing:approve-orders') ? [{ key: 'approvals', label: 'Requests to Approve' }] : []),
    ...(has('purchasing:setup') || hasAny('purchasing:request', ...KEEPER_PERMISSIONS) ? [{ key: 'setup', label: 'Setup' }] : []),
  ] as const;
  return (
    <nav aria-label="Purchasing" className="mb-3 flex gap-6 border-b">
      {tabs.map((tab) => (
        <Link
          aria-current={tab.key === current ? 'page' : undefined}
          className={cn('-mb-px border-b-2 pb-2 text-sm font-medium', tab.key === current ? 'border-primary text-heading' : 'text-muted-foreground hover:text-foreground border-transparent')}
          href={`/purchasing?tab=${tab.key}`}
          key={tab.key}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
