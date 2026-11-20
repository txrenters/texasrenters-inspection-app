'use client';

import Link from 'next/link';

import { usePermissions } from '@/lib/auth';
import { cn } from '@/lib/utils';

/**
 * Purchasing's tabs across the top of a requisition, as the canvas draws them
 * (2026-11-20): Requisitions marked, Orders and Codes a click away. Codes only
 * for whoever may keep them.
 */
export function PurchasingTabs({ current }: { current: 'requisitions' | 'orders' | 'codes' | 'setup' }) {
  const { has } = usePermissions();
  const tabs = [
    { key: 'requisitions', label: 'Requisitions' },
    { key: 'orders', label: 'Orders' },
    ...(has('purchasing:codes') ? [{ key: 'codes', label: 'Codes' }] : []),
    ...(has('purchasing:setup') ? [{ key: 'setup', label: 'Setup' }] : []),
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
