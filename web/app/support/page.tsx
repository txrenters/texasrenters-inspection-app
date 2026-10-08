import type { Metadata } from 'next';
import Link from 'next/link';

import { ContactDetails, PublicDocument } from '@/components/public-document';

export const metadata: Metadata = {
  title: { absolute: 'Support | TexasRenters Inspection' },
  description: 'Help with the TexasRenters Inspection app, and how to reach us.',
};

/** The support page the App Store listing links to. Names only screens the app has. */
export default function SupportPage() {
  return (
    <PublicDocument title="TexasRenters Inspection support">
      <section>
        <p>
          TexasRenters Inspection is the app TexasRenters technicians use to inspect the rental homes we
          manage: they record each room on video with spoken notes, take photos, and complete each
          room&rsquo;s checklist.
        </p>
      </section>

      <section>
        <h2>Getting an account</h2>
        <p>
          Accounts are created by the TexasRenters office; the app has no public sign-up. If you work with
          TexasRenters and need access, contact us below.
        </p>
      </section>

      <section>
        <h2>Signing in</h2>
        <p>
          If you have forgotten your password, tap &ldquo;Forgot password?&rdquo; on the sign-in screen
          and we will email you a link to set a new one. If the email does not arrive, contact us.
        </p>
      </section>

      <section>
        <h2>Problems with recordings or uploads</h2>
        <p>
          Open Settings in the app, then Diagnostics, and tap &ldquo;Copy diagnostics&rdquo;. Paste the
          result into an email to us with a short description of what happened.
        </p>
      </section>

      <section>
        <h2>Location and privacy</h2>
        <p>
          The app records your location while you are signed in. You can pause it with &ldquo;Share my
          location&rdquo; in Settings. Our <Link href="/privacy">privacy policy</Link> explains what the app
          collects and how to ask us to delete it.
        </p>
      </section>

      <section>
        <h2>Contact us</h2>
        <ContactDetails />
      </section>
    </PublicDocument>
  );
}
