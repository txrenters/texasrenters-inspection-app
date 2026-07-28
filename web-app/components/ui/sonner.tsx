'use client';

import { useEffect, useState } from 'react';
import { Toaster as SonnerToaster, toast } from 'sonner';

/**
 * The application's single notification surface. There was none before, so
 * mutation feedback was rendered as ad-hoc inline alerts on each page.
 *
 * Theme follows the app's own `data-theme` attribute rather than next-themes,
 * which this project does not use — the toggle stamps the attribute on <html>
 * and writes to localStorage.
 */
export function Toaster() {
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');

  useEffect(() => {
    const root = document.documentElement;
    const read = () => setTheme(root.getAttribute('data-theme') === 'light' ? 'light' : 'dark');
    read();
    // Keep toasts in step when the user flips the theme mid-session.
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  return (
    <SonnerToaster
      theme={theme}
      position="bottom-right"
      closeButton
      toastOptions={{
        classNames: {
          toast: 'border border-border bg-card text-foreground',
          description: 'text-muted-foreground',
        },
      }}
    />
  );
}

export { toast };
