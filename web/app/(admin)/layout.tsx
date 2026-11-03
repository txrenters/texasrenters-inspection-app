import { cookies } from 'next/headers';
import type { ReactNode } from 'react';

import { AppShell } from '@/components/app-shell';
import { CONSOLE_SHELL_COOKIE, parseConsoleShell } from '@/lib/console-shell';

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const cookieStore = await cookies();
  const defaultSidebarOpen = cookieStore.get('sidebar_state')?.value !== 'false';
  // Read here, on the server, so the chosen frame is the first one painted.
  const shell = parseConsoleShell(cookieStore.get(CONSOLE_SHELL_COOKIE)?.value);

  return (
    <AppShell defaultSidebarOpen={defaultSidebarOpen} shell={shell}>
      {children}
    </AppShell>
  );
}
