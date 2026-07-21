'use client';

import { PageHeader } from '@/components/ui';
import { useAuth } from '@/lib/auth';

export default function SettingsPage() {
  const { profile } = useAuth();
  const membership = profile?.memberships[0];
  return (
    <>
      <PageHeader
        title="Settings"
        description="Organization-level administrative context and operating safeguards."
      />
      <div className="dashboard-grid">
        <section className="panel">
          <h2>Organization</h2>
          <div className="detail-grid compact-grid">
            <div className="detail-item">
              <span>Name</span>
              <strong>{membership?.organization.name ?? 'Unavailable'}</strong>
            </div>
            <div className="detail-item">
              <span>Organization ID</span>
              <strong className="mono">{membership?.organization.id ?? 'Unavailable'}</strong>
            </div>
            <div className="detail-item">
              <span>Your role</span>
              <strong>{membership?.role.replaceAll('_', ' ') ?? 'Unavailable'}</strong>
            </div>
          </div>
        </section>
        <section className="panel">
          <h2>Data boundary</h2>
          <p>
            The admin application uses authenticated backend REST endpoints. It never connects
            directly to PostgreSQL or receives provider credentials.
          </p>
        </section>
      </div>
      <section className="panel section-gap">
        <h2>Human review safeguards</h2>
        <ul className="plain-list">
          <li>AI room tags remain drafts until an authorized person approves them.</li>
          <li>AI findings remain pending review until an authorized person reviews them.</li>
          <li>AI does not approve tenant charges or decide legal responsibility.</li>
          <li>One video belongs to exactly one approved room and one inspection area.</li>
        </ul>
      </section>
    </>
  );
}
