import type { Metadata } from 'next';
import Link from 'next/link';

import { CONTACT, ContactDetails, PublicDocument } from '@/components/public-document';

export const metadata: Metadata = {
  title: { absolute: 'Privacy Policy | TexasRenters Inspection' },
  description: 'What the TexasRenters Inspection app collects, why, who receives it and how long it is kept.',
};

/**
 * The privacy policy the App Store listing links to.
 *
 * Written from what the code does, not from what the permission prompts say.
 * In particular location: `mobile/src/location/ShiftAutoStart.tsx` records for
 * as long as a technician is signed in, in the background too, and only the
 * "Share my location" pause in Settings or signing out stops it. Change that
 * behaviour, a processor, or a retention period, and this page changes with it
 * -- along with the App Privacy answers in App Store Connect.
 */
export default function PrivacyPolicyPage() {
  return (
    <PublicDocument title="Privacy Policy for the TexasRenters Inspection app" updated="October 9, 2026">
      <section>
        <p>
          TexasRenters Inspection is made by {CONTACT.company} (&ldquo;TexasRenters&rdquo;, &ldquo;we&rdquo;)
          for the technicians who inspect the rental homes we manage. This policy explains what the app
          collects, why, who receives it, and how long we keep it. Accounts are created by our office; the
          app has no public sign-up.
        </p>
      </section>

      <section>
        <h2>What the app collects</h2>
        <ul>
          <li>
            <strong>Account details.</strong> Your name and work email address, and your password, which
            we store only in a form that cannot be turned back into the password. When you sign in we
            record a random identifier the app creates when it is installed, the type of device, and the
            IP address it signed in from.
          </li>
          <li>
            <strong>Location.</strong> While you are signed in, the app records your phone&rsquo;s precise
            location, including when the app is in the background or the screen is locked. Each reading
            includes the position and its accuracy, speed, direction, the time, and the phone&rsquo;s
            battery level. Recording stops when you sign out, and while you turn off &ldquo;Share my
            location&rdquo; in the app&rsquo;s Settings. The office can see when it is turned off.
          </li>
          <li>
            <strong>Home address.</strong> If you enter one, it is used as the starting point of your
            daily route. You can remove it at any time under Home address in the app&rsquo;s Settings.
          </li>
          <li>
            <strong>Inspection recordings and photos.</strong> Videos you record of each room, including
            their sound (your spoken notes), photos you take, photos you choose from your photo library,
            and your notes and checklist answers. The app can only read the photos you pick; it never
            reads the rest of your library. While you record a room, the phone&rsquo;s motion sensors
            guide the walkthrough; only a summary (how far you turned) is sent, never the raw sensor
            readings.
          </li>
          <li>
            <strong>Diagnostics.</strong> If the app hits an error, crashes, or is closed by the operating
            system, it sends us a report with the error, the app version, the phone&rsquo;s type and
            operating system, and the random identifier above. Every few minutes it also reports whether
            location permission and location services are on, so the office can tell when recording has
            stopped.
          </li>
          <li>
            <strong>Notifications.</strong> If you allow notifications, a token that lets us send job
            updates to your phone.
          </li>
        </ul>
        <p>
          The app does not access your contacts or calendar, does not use advertising identifiers, shows
          no advertising, does not track you across other companies&rsquo; apps or websites, and we do not
          sell your information.
        </p>
      </section>

      <section>
        <h2>How we use it</h2>
        <ul>
          <li>To sign you in and keep your account secure.</li>
          <li>
            To schedule and route your visits, to show the office where technicians are during the working
            day, and to record your arrival at and departure from each property for your timesheet.
          </li>
          <li>
            To produce inspection reports for the homes we manage. Recordings are transcribed, and
            automated tools (AI) draft findings, room summaries and checklist answers from them; our office
            staff review those drafts before a report is completed.
          </li>
          <li>To find and fix problems with the app.</li>
        </ul>
      </section>

      <section>
        <h2>Who receives it</h2>
        <p>
          We share information only with the service providers that run parts of the service for us, and
          only for that purpose:
        </p>
        <ul>
          <li>
            <strong>Cloudflare</strong> stores and plays back videos and stores photos.
          </li>
          <li>
            <strong>Deepgram</strong> and <strong>OpenAI</strong> transcribe the sound of recordings.
          </li>
          <li>
            <strong>Anthropic</strong> and <strong>OpenAI</strong> analyse transcripts, and stills and
            photos from inspections, to draft findings.
          </li>
          <li>
            <strong>Mapbox</strong> and <strong>Google</strong> work out driving routes and place addresses
            on the map, including your home address and route starting points.
          </li>
          <li>
            <strong>Expo</strong>, <strong>Apple</strong> and <strong>Google</strong> (Firebase Cloud
            Messaging) deliver notifications and app updates.
          </li>
          <li>
            <strong>Microsoft</strong> delivers account and password-reset emails.
          </li>
          <li>
            <strong>Jobber</strong>, our scheduling system, holds the visits assigned to you and records
            when they are completed.
          </li>
        </ul>
        <p>
          Inspection reports, which can include photos and stills from recordings, are shared with the
          owner and the tenants of the property inspected. We may also disclose information when the law
          requires it.
        </p>
      </section>

      <section>
        <h2>How long we keep it</h2>
        <ul>
          <li>
            Individual location readings are deleted after 30 days. The timesheet records made from them
            (arrival and departure times and hours worked) are kept as employment records.
          </li>
          <li>
            Inspection recordings, photos and reports are kept as part of the property&rsquo;s records.
          </li>
          <li>Account details are kept for as long as your account is open.</li>
        </ul>
      </section>

      <section>
        <h2>Your choices</h2>
        <ul>
          <li>
            You can pause location recording with &ldquo;Share my location&rdquo; in the app&rsquo;s
            Settings, or by signing out. You can also withdraw location permission in iOS Settings, but
            routes and your timesheet will not work without it.
          </li>
          <li>
            iOS asks before the app first uses the camera, microphone, photo library or notifications, and
            you can change each of these in iOS Settings at any time.
          </li>
          <li>
            To see, correct or delete information we hold about you, contact us using the details below.
            Recordings and reports that are part of a property&rsquo;s inspection record may be kept after
            your account is closed.
          </li>
        </ul>
      </section>

      <section>
        <h2>Security</h2>
        <p>
          Everything the app sends travels over an encrypted connection. Access to location history and
          inspection records in our office console is limited to staff whose role needs it.
        </p>
      </section>

      <section>
        <h2>Children</h2>
        <p>The app is for TexasRenters&rsquo; working staff and is not directed at children.</p>
      </section>

      <section>
        <h2>Changes to this policy</h2>
        <p>
          When we change this policy we will post the new version on this page and update the date at the
          top.
        </p>
      </section>

      <section>
        <h2>Contact us</h2>
        <p>
          Questions about this policy or your information? Contact {CONTACT.company}. For help with the
          app itself, see <Link href="/support">Support</Link>.
        </p>
        <ContactDetails />
      </section>
    </PublicDocument>
  );
}
