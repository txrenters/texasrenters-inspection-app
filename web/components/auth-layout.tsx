import type { ReactNode } from 'react';

import { SECTION_LABEL } from '@/components/panel';
import { ThemeToggleInline } from '@/components/theme-toggle';

/**
 * The console's calm mark, as the sidebar draws it (console-development): the
 * navy tile with the green house, the name in plain semibold beside it, and
 * "Inspection" as a section label. It replaced a 36px extrabold uppercase
 * "INSPECTION" in the primary colour under a raster logo that had to be
 * inverted for dark mode -- the loudest thing on a screen whose job is a
 * two-field form. The tile carries its own background, so it reads the same
 * in light and dark. Shared with the public privacy and support pages.
 */
export function BrandLockup() {
  return (
    <span className="flex items-center justify-center gap-2.5">
      {/* Decorative: the name is the text beside it. `next/image` would need
          `dangerouslyAllowSVG` for no gain on a small vector. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img alt="" className="size-7 shrink-0 rounded-md" src="/brand/logo-mark-tile.svg" />
      <span className="flex flex-col text-left leading-tight">
        <span className="text-foreground text-xl font-semibold tracking-tight">TexasRenters</span>
        <span className={SECTION_LABEL}>Inspection</span>
      </span>
    </span>
  );
}

/**
 * The frame every signed-out screen sits in.
 *
 * One centred column, not the old two-column split. That split gave half the
 * viewport to three marketing bullets on a screen whose only purpose is a
 * two-field form — and below 860px it collapsed anyway, so the layout everyone
 * on a laptop saw was the one designed for a phone.
 */
export function AuthLayout({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main className="bg-muted/40 relative flex min-h-dvh flex-col items-center justify-center p-4">
      <div className="absolute top-4 right-4">
        <ThemeToggleInline />
      </div>

      <div className="w-full max-w-sm space-y-6">
        <BrandLockup />

        <div className="bg-card rounded-xl border p-6">
          <div className="mb-5 space-y-1.5">
            <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
            {description ? (
              <p className="text-muted-foreground text-sm text-pretty">{description}</p>
            ) : null}
          </div>
          {children}
        </div>

        {footer ? (
          <div className="text-muted-foreground text-center text-xs text-balance">{footer}</div>
        ) : null}
      </div>
    </main>
  );
}
