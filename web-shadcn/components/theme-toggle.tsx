'use client';

import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react';
import { useTheme } from 'next-themes';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * Both icons are always rendered; CSS decides which is visible.
 *
 * Nothing here reads the resolved theme during render, which is the point. The
 * server cannot know it, so any markup derived from it — an icon, and more
 * subtly an `aria-label` saying which way the control will switch — differs
 * between the server HTML and the first client render and trips React's
 * hydration check. The usual `mounted` flag fixes the icon and is easy to forget
 * on the label; `dark:` variants need no flag at all, because the `.dark` class
 * next-themes writes onto <html> is already in place before React hydrates.
 */
function ThemeIcons() {
  return (
    <>
      <SunIcon className="dark:hidden" />
      <MoonIcon className="hidden dark:block" />
    </>
  );
}

/**
 * One control, three choices.
 *
 * The old app rendered a three-button segmented group in the header, which cost
 * ~100px of horizontal space on every screen to expose a setting most people
 * change once.
 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button aria-label="Change colour theme" size="icon-sm" variant="ghost">
          <ThemeIcons />
        </Button>
      </DropdownMenuTrigger>
      {/* Portalled and only mounted once open, so reading `theme` here is
          client-only and cannot mismatch. */}
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup onValueChange={setTheme} value={theme}>
          <DropdownMenuRadioItem value="light">
            <SunIcon />
            Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <MoonIcon />
            Dark
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <MonitorIcon />
            System
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Straight light/dark flip, for the signed-out screens. */
export function ThemeToggleInline() {
  const { resolvedTheme, setTheme } = useTheme();

  return (
    <Button
      // Deliberately direction-neutral. "Switch to dark theme" would have to be
      // computed from the resolved theme, which is exactly the value that is
      // unknown at render time on the server.
      aria-label="Toggle light and dark theme"
      onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
      size="icon-sm"
      variant="ghost"
    >
      <ThemeIcons />
    </Button>
  );
}
