'use client';

import Link from 'next/link';

import { buttonVariants } from '@/components/ui/button';
import { usePermissions } from '@/lib/auth';
import { cn } from '@/lib/utils';

/**
 * "Show inspection details", from a window on the technician map (the office,
 * 2026-10-02).
 *
 * In a new tab: the map is a live view -- who is selected, which day, where
 * everybody is -- and leaving it to read one inspection would throw all of that
 * away. Drawn only for somebody who may read inspections, so the button never
 * leads to a page that refuses them.
 */
export function InspectionDetailsLink({
  className,
  inspectionId,
}: {
  className?: string;
  inspectionId: string;
}) {
  const permissions = usePermissions();
  if (!permissions.has('inspections:read')) return null;
  return (
    <Link
      className={cn(buttonVariants({ size: 'sm', variant: 'outline' }), 'h-7 w-full text-xs', className)}
      href={`/inspections/${inspectionId}`}
      rel="noopener"
      target="_blank"
    >
      Show inspection details
    </Link>
  );
}
