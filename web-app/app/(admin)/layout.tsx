import type { ReactNode } from 'react';
import { cookies } from 'next/headers';

import { AppShell } from '@/components/app-shell';

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const cookieStore = await cookies();
  const defaultSidebarOpen = cookieStore.get('sidebar_state')?.value !== 'false';

  return <AppShell defaultSidebarOpen={defaultSidebarOpen}>{children}</AppShell>;
}
