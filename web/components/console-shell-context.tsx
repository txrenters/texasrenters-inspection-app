'use client';

import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, type ReactNode } from 'react';

import { consoleShellCookie, DEFAULT_CONSOLE_SHELL, type ConsoleShell } from '@/lib/console-shell';

const ConsoleShellContext = createContext<ConsoleShell>(DEFAULT_CONSOLE_SHELL);

/** The frame the admin layout chose, for the controls that offer the other one. */
export function ConsoleShellProvider({ shell, children }: { shell: ConsoleShell; children: ReactNode }) {
  return <ConsoleShellContext.Provider value={shell}>{children}</ConsoleShellContext.Provider>;
}

/** Classic outside a provider, which is what every page rendered alone in a test is. */
export function useConsoleShell() {
  return useContext(ConsoleShellContext);
}

/**
 * Switches frame without a page load.
 *
 * The cookie is the choice; `router.refresh()` re-renders the server layout that
 * reads it. The frame and the page are remounted (anything half-typed in a form
 * goes with them), but the providers above the frame are not, so the data
 * already loaded is still there and the page comes straight back.
 */
export function useSwitchConsoleShell() {
  const router = useRouter();
  return useCallback(
    (shell: ConsoleShell) => {
      document.cookie = consoleShellCookie(shell);
      router.refresh();
    },
    [router],
  );
}
