'use client';

import { ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Fragment } from 'react';

import { HeaderClocks } from '@/components/header-clocks';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { getAdminBreadcrumbs } from '@/lib/admin-navigation';
import { ThemeSelector } from '@/lib/theme';

export function AppHeader() {
  const pathname = usePathname();
  const breadcrumbs = getAdminBreadcrumbs(pathname);

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background px-4">
      <SidebarTrigger
        aria-label="Toggle application navigation"
        className="shrink-0"
      />
      <Separator className="mr-2 h-4!" orientation="vertical" />
      <Breadcrumb className="min-w-0 flex-1">
        <BreadcrumbList className="flex-nowrap overflow-hidden">
          {breadcrumbs.map((breadcrumb, index) => (
            <Fragment key={`${breadcrumb.title}-${index}`}>
              {index > 0 ? <BreadcrumbSeparator /> : null}
              <BreadcrumbItem className="min-w-0">
                {breadcrumb.href ? (
                  <BreadcrumbLink asChild>
                    <Link className="truncate" href={breadcrumb.href}>
                      {breadcrumb.title}
                    </Link>
                  </BreadcrumbLink>
                ) : (
                  <BreadcrumbPage className="truncate font-semibold">
                    {breadcrumb.title}
                  </BreadcrumbPage>
                )}
              </BreadcrumbItem>
            </Fragment>
          ))}
        </BreadcrumbList>
      </Breadcrumb>
      <HeaderClocks />
      <Separator className="mr-1 hidden h-4! md:block" orientation="vertical" />
      <div className="hidden items-center gap-2 text-xs text-muted-foreground lg:flex">
        <ShieldCheck aria-hidden className="size-4 text-primary" />
        <span className="size-2 rounded-full bg-accent shadow-[0_0_0_3px_var(--green-soft)]" />
        Secure workspace
      </div>
      <ThemeSelector />
    </header>
  );
}
