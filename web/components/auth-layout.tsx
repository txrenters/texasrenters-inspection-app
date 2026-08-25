import Image from 'next/image';
import type { ReactNode } from 'react';

import { ThemeToggleInline } from '@/components/theme-toggle';

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
        {/* The product name is the wordmark, not a caption.

            It was 12px, muted and letter-spaced under the logo — the smallest
            text on a screen whose whole job is to say which TexasRenters
            application you have arrived at. The maintenance app sets its own
            name at wordmark scale directly beneath the same logo, and this now
            matches: one lock-up, read as a unit.

            `leading-none` and a tight gap so the two lines sit as one mark
            rather than as a heading with a subtitle under it. */}
        <div className="flex flex-col items-center gap-1">
          <Image
            alt="TexasRenters"
            className="h-8 w-auto dark:brightness-0 dark:invert"
            height={167}
            priority
            src="/texasrenterslogo-transparent.png"
            width={600}
          />
          <span className="text-primary text-4xl leading-none font-extrabold tracking-tight uppercase">
            Inspection
          </span>
        </div>

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
