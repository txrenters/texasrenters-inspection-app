'use client';

import { useTheme } from 'next-themes';
import { useEffect, useState, type CSSProperties } from 'react';
import { Toaster as Sonner, type ToasterProps } from 'sonner';

/**
 * Mounted-gated, deliberately.
 *
 * This sits in the root layout, so it renders on the server — where the theme is
 * unknowable. `useTheme()` returns nothing there but is already populated from
 * localStorage on the first client render, so passing it straight through gives
 * the toaster one `data-theme` in the server HTML and another at hydration.
 * Same class of bug as an `aria-label` derived from the theme.
 *
 * Rendering nothing until mounted costs nothing here: there are no toasts before
 * the first interaction, so there is nothing for the server to have emitted.
 */
function Toaster({ ...props }: ToasterProps) {
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  return (
    <Sonner
      className="toaster group"
      position="bottom-right"
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
        } as CSSProperties
      }
      theme={(resolvedTheme as ToasterProps['theme']) ?? 'system'}
      {...props}
    />
  );
}

export { Toaster };
